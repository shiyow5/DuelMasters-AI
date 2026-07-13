import { embedSingle } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { SearchResult } from "@dm-ai/core";
import { extractTerms } from "./terms.js";

interface SearchOptions {
  topK?: number;
  docType?: string;
  /**
   * 総合ルール条文に必ず割り当てる枠。混在コーパスでは裁定 (3246件) が条文 (600件) を
   * 数で圧倒し、条文が1件も返らないことがある。実際、S・トリガーの任意性を定めた 113.6 が
   * retrieve されず「使うか選べる」と答えられなかった。
   */
  ruleQuota?: number;
  /**
   * 上位に来た条文と同じ節から補う兄弟条文の最大数 (0 で無効)。
   * 条文は節単位でひとまとまりの規定になっており、例外は本則と語彙が違うため単独クエリでは
   * 引けない。「1ターンの流れ」で本則 500.1 は取れても、例外 500.6 (先攻は第1ターンのドローを
   * 飛ばす) が取れず、回答が例外に触れられなかった。
   */
  sectionExpansion?: number;
}

const RULES_DOC_TYPE = "comprehensive_rules";
const DEFAULT_RULE_QUOTA = 3;
const DEFAULT_SECTION_EXPANSION = 6;

type Sql = ReturnType<typeof getSql>;

interface ChunkResult {
  id: number;
  text: string;
  score: number;
  meta: Record<string, unknown>;
}

/**
 * ハイブリッド検索: キーワード + ベクトル検索の結果をマージ
 */
export async function searchRules(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const {
    topK = 8,
    docType,
    ruleQuota = DEFAULT_RULE_QUOTA,
    sectionExpansion = DEFAULT_SECTION_EXPANSION,
  } = options;
  const sql = getSql();
  const embedding = await embedSingle(query);

  if (docType !== undefined) {
    const chunks = await hybridSearch(sql, query, embedding, topK, docType);
    return toResult(chunks);
  }

  // 条文の枠を先に確保してから、残りを全体スコア順で埋める。
  const [rules, overall] = await Promise.all([
    ruleQuota > 0
      ? hybridSearch(sql, query, embedding, ruleQuota, RULES_DOC_TYPE)
      : Promise.resolve([]),
    hybridSearch(sql, query, embedding, topK, undefined),
  ]);

  const chunks: ChunkResult[] = [];
  const seen = new Set<number>();
  for (const r of [...rules, ...overall]) {
    if (chunks.length >= topK) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    chunks.push(r);
  }

  const siblings = await expandTopSection(sql, embedding, chunks, seen, sectionExpansion);
  return toResult([...chunks, ...siblings]);
}

/** 最上位の条文と同じ節から、まだ拾っていない兄弟条文をクエリに近い順で補う。 */
async function expandTopSection(
  sql: Sql,
  embedding: number[],
  chunks: ChunkResult[],
  seen: Set<number>,
  limit: number,
): Promise<ChunkResult[]> {
  if (limit <= 0) return [];
  const top = chunks.find((c) => c.meta.doc_type === RULES_DOC_TYPE);
  const section = top?.meta.section;
  if (typeof section !== "string" || section.length === 0) return [];

  const exclude = seen.size > 0 ? Array.from(seen) : [-1];
  const vecParam = `[${embedding.join(",")}]`;
  const rows = await sql`
    SELECT id, doc_type, chunk_text, chunk_meta,
           1 - (embedding <=> ${vecParam}::vector) AS similarity
    FROM rule_chunks
    WHERE doc_type = ${RULES_DOC_TYPE}
      AND chunk_meta->>'section' = ${section}
      AND embedding IS NOT NULL
      AND id NOT IN ${sql(exclude)}
    ORDER BY embedding <=> ${vecParam}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => toChunk(row, row.similarity as number));
}

function toResult(chunks: ChunkResult[]): SearchResult {
  return {
    chunks: chunks.map(({ text, score, meta }) => ({ text, score, meta })),
    total: chunks.length,
  };
}

/** キーワード + ベクトルを1つの doc_type スコープで検索してマージする。 */
async function hybridSearch(
  sql: Sql,
  query: string,
  embedding: number[],
  topK: number,
  docType: string | undefined,
): Promise<ChunkResult[]> {
  const [keywordResults, vectorResults] = await Promise.all([
    searchByKeyword(sql, query, topK, docType),
    searchByVector(sql, embedding, topK, docType),
  ]);
  return mergeResults(keywordResults, vectorResults, topK);
}

/** キーワード検索 (ILIKE ベース) */
async function searchByKeyword(
  sql: Sql,
  query: string,
  topK: number,
  docType?: string,
): Promise<ChunkResult[]> {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];

  const patterns = terms.map((t) => `%${t}%`);
  const matchExpr = patterns
    .map((p) => sql`(chunk_text ILIKE ${p})::int`)
    .reduce((acc, frag) => sql`${acc} + ${frag}`);
  const whereExpr = patterns
    .map((p) => sql`chunk_text ILIKE ${p}`)
    .reduce((acc, frag) => sql`${acc} OR ${frag}`);

  const rows = await sql`
    SELECT id, doc_type, chunk_text, chunk_meta,
           (${matchExpr}) AS match_count
    FROM rule_chunks
    WHERE (${whereExpr}) ${docType ? sql`AND doc_type = ${docType}` : sql``}
    ORDER BY match_count DESC
    LIMIT ${topK}
  `;

  return rows.map((row) => toChunk(row, (Number(row.match_count) / terms.length) * 0.5));
}

/** ベクトル検索 (cosine similarity) */
async function searchByVector(
  sql: Sql,
  embedding: number[],
  topK: number,
  docType?: string,
): Promise<ChunkResult[]> {
  const vecParam = `[${embedding.join(",")}]`;

  // HNSW は近傍を先に取ってから WHERE を適用する (後置フィルタ)。doc_type で絞ると
  // 候補が全部ふるい落とされ、条文が存在するのに 0 行が返る事象が実際に起きていた。
  // pgvector 0.8 の反復スキャンで、必要件数が埋まるまで走査を続けさせる。
  const rows = await sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    await txSql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`;
    return txSql`
      SELECT id, doc_type, chunk_text, chunk_meta,
             1 - (embedding <=> ${vecParam}::vector) AS similarity
      FROM rule_chunks
      WHERE embedding IS NOT NULL ${docType ? txSql`AND doc_type = ${docType}` : txSql``}
      ORDER BY embedding <=> ${vecParam}::vector
      LIMIT ${topK}
    `;
  });

  return (rows as unknown as Array<Record<string, unknown>>).map((row) =>
    toChunk(row, row.similarity as number),
  );
}

/** doc_type は meta に載せて返す。回答時に条文 (一次情報) と裁定 (Q&A) を区別するため。 */
function toChunk(row: Record<string, unknown>, score: number): ChunkResult {
  return {
    id: row.id as number,
    text: row.chunk_text as string,
    score,
    meta: {
      ...((row.chunk_meta as Record<string, unknown>) ?? {}),
      doc_type: row.doc_type as string,
    },
  };
}

/** 結果マージ・重複排除・スコア順ソート */
function mergeResults(keyword: ChunkResult[], vector: ChunkResult[], topK: number): ChunkResult[] {
  const seen = new Map<number, ChunkResult>();

  for (const r of keyword) {
    const existing = seen.get(r.id);
    if (existing) {
      seen.set(r.id, { ...existing, score: Math.max(existing.score, r.score) });
    } else {
      seen.set(r.id, { ...r });
    }
  }

  // 両方にヒットした場合はスコアをブースト
  for (const r of vector) {
    const existing = seen.get(r.id);
    if (existing) {
      seen.set(r.id, { ...existing, score: existing.score + r.score * 0.5 });
    } else {
      seen.set(r.id, { ...r });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
