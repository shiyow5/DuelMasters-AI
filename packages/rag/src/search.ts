import { embedSingle } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { SearchResult } from "@dm-ai/core";

interface SearchOptions {
  topK?: number;
  docType?: string;
}

/**
 * ハイブリッド検索: キーワード + ベクトル検索の結果をマージ
 */
export async function searchRules(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult> {
  const { topK = 8, docType } = options;
  const sql = getSql();

  // 並列で keyword + vector 検索
  const [keywordResults, vectorResults] = await Promise.all([
    searchByKeyword(sql, query, topK, docType),
    searchByVector(sql, query, topK, docType),
  ]);

  // マージ & 重複排除
  const merged = mergeResults(keywordResults, vectorResults, topK);

  return {
    chunks: merged,
    total: merged.length,
  };
}

interface ChunkResult {
  id: number;
  text: string;
  score: number;
  meta: Record<string, unknown>;
}

/** キーワード検索 (LIKE ベース) */
async function searchByKeyword(
  sql: ReturnType<typeof getSql>,
  query: string,
  topK: number,
  docType?: string
): Promise<ChunkResult[]> {
  const keywords = query
    .split(/[\s　、。,.]/)
    .filter((k) => k.length > 0)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  const conditions = keywords.map((k) => `chunk_text ILIKE '%' || '${escapeSql(k)}' || '%'`);
  const whereClause = conditions.join(" OR ");
  const docFilter = docType ? `AND doc_type = '${escapeSql(docType)}'` : "";

  const rows = await sql.unsafe(`
    SELECT id, chunk_text, chunk_meta,
           (${conditions.map(() => "1").join(" + ")}) as match_count
    FROM rule_chunks
    WHERE (${whereClause}) ${docFilter}
    ORDER BY match_count DESC
    LIMIT ${topK}
  `);

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as number,
    text: row.chunk_text as string,
    score: ((row.match_count as number) / keywords.length) * 0.5,
    meta: (row.chunk_meta as Record<string, unknown>) ?? {},
  }));
}

/** ベクトル検索 (cosine similarity) */
async function searchByVector(
  sql: ReturnType<typeof getSql>,
  query: string,
  topK: number,
  docType?: string
): Promise<ChunkResult[]> {
  const embedding = await embedSingle(query);
  const vecStr = `[${embedding.join(",")}]`;
  const docFilter = docType ? `AND doc_type = '${escapeSql(docType)}'` : "";

  const rows = await sql.unsafe(`
    SELECT id, chunk_text, chunk_meta,
           1 - (embedding <=> '${vecStr}'::vector) as similarity
    FROM rule_chunks
    WHERE embedding IS NOT NULL ${docFilter}
    ORDER BY embedding <=> '${vecStr}'::vector
    LIMIT ${topK}
  `);

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as number,
    text: row.chunk_text as string,
    score: row.similarity as number,
    meta: (row.chunk_meta as Record<string, unknown>) ?? {},
  }));
}

/** 結果マージ・重複排除・スコア順ソート */
function mergeResults(
  keyword: ChunkResult[],
  vector: ChunkResult[],
  topK: number
): Array<{ text: string; score: number; meta: Record<string, unknown> }> {
  const seen = new Map<number, ChunkResult>();

  // キーワード結果を追加
  for (const r of keyword) {
    const existing = seen.get(r.id);
    if (existing) {
      existing.score = Math.max(existing.score, r.score);
    } else {
      seen.set(r.id, { ...r });
    }
  }

  // ベクトル結果を追加 (ハイブリッドスコア)
  for (const r of vector) {
    const existing = seen.get(r.id);
    if (existing) {
      // 両方にヒットした場合はスコアをブースト
      existing.score = existing.score + r.score * 0.5;
    } else {
      seen.set(r.id, { ...r });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ text, score, meta }) => ({ text, score, meta }));
}

/** SQL インジェクション対策 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
