/**
 * 裁定 Q&A を総合ルールと突き合わせ、現行ルールと矛盾するものを検出する監査ジョブ (#92)。
 *
 * 公式サイトの qa_old には改定前の裁定がそのまま残っている。例えば qa_id 34932 は
 * 「トリガー能力をすべて使ってからアンタップする」と答えるが、総合ルールは
 * 501.1 (アンタップ) → 501.2 (「ターンのはじめに」誘発) → 502.1 (ドロー) の順と定めており、
 * 順序が逆になっている。RAG がこれを引くと agent の回答が汚れる (eval で実害が出た)。
 *
 * ## 判定を信用しないための作り
 *
 * LLM の「矛盾している」という判断は**それ単体では採用しない**。過去に judge は
 * カードの実在性も DM のルールも誤った。そこで LLM には必ず
 * 「どの条番号の、どの文言と矛盾するのか」を**逐語引用**で答えさせ、
 * その条番号が実在し、引用が本当にその条文の部分列であることを **機械的に検証**する
 * (verifyGrounding)。捏造した条番号や、paraphrase した「引用」はここで落ちる。
 *
 * 出力はレビュー可能な一覧。実際に降格するのは人がレビューして
 * `src/data/deprecated-rulings.ts` に載せたものだけ (削除はしない = 戻せる)。
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { getSql, closeDb } from "@dm-ai/db";
import { generateStructured, Type } from "@dm-ai/core";

/** 総合ルールの1条文。 */
export interface RuleArticle {
  article: string;
  text: string;
}

/** LLM が返す矛盾判定。 */
export interface AuditVerdict {
  contradicts: boolean;
  article: string;
  quote: string;
  reason: string;
}

/** 監査対象の裁定。 */
export interface RulingRow {
  id: number;
  qaId: number;
  question: string;
  text: string;
}

/** 矛盾が裏取りできた裁定。 */
export interface Contradiction {
  qaId: number;
  question: string;
  article: string;
  quote: string;
  reason: string;
}

/**
 * カード名の囲み記号。公式サイトは1種類に統一していないので、実測した4種すべてを見る。
 * 《》3649回 / ≪≫ 38回 (U+226A/226B の数学記号) / 『』22回 / «» (U+00AB/00BB)。
 *
 * 「」と【】は**含めない**。これらは能力名 (「革命チェンジ」) や分類ラベル (【基本ルール】) に
 * 使われる表記であって、カード名ではない。含めてしまうと一般ルール裁定 —— 最も現行ルールと
 * 矛盾しやすい層 —— が監査対象から丸ごと漏れる。
 */
const CARD_BRACKET = /[《≪«『][^》≫»』]{2,}[》≫»』]/;

/** 引用として根拠になる最短長。これ未満だと偶然どの条文にも一致してしまう。 */
const MIN_QUOTE_LENGTH = 8;

/** 1裁定あたり LLM に見せる条文数。 */
const ARTICLES_PER_RULING = 10;

/** 同時に走らせる LLM 呼び出し数。 */
const CONCURRENCY = 4;

/**
 * 質問文が特定のカードについてのものか。
 *
 * カード個別の裁定 (2589件) は「そのカードのテキストをどう解釈するか」であって、
 * 総合ルールの条文と正面から矛盾することは稀。一方、カード名を含まない一般ルール裁定
 * (611件) は、ルール改定で丸ごと古くなる。監査はここに絞る (3200 → 611 で 81% 削減)。
 */
export function isCardSpecific(question: string): boolean {
  return CARD_BRACKET.test(question);
}

/**
 * 引用の照合用に正規化する。
 * 総合ルールは PDF 抽出なので、原文に折り返し由来の改行・空白が混ざる
 * (「それ\nらを同時に」)。LLM は空白を詰めて引用してくるため、素の substring 判定では
 * **正しい引用まで落ちる**。空白を全部落として比べる。
 */
function normalizeForQuote(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "");
}

/**
 * LLM の矛盾判定を、総合ルールの原文に照らして機械的に裏取りする。
 *
 * これが #92 の安全装置。LLM が「矛盾している」と言っただけでは何も降格しない。
 * 条番号が実在し、引用がその条文の逐語部分列であって初めて採用する。
 */
export function verifyGrounding(
  verdict: AuditVerdict,
  articles: RuleArticle[],
): { ok: boolean; reason?: string } {
  if (!verdict.contradicts) return { ok: false, reason: "矛盾なしと判定" };

  const article = verdict.article?.trim() ?? "";
  const quote = verdict.quote?.trim() ?? "";
  if (article === "" || quote === "") return { ok: false, reason: "条番号または引用が空" };

  const found = articles.find((a) => a.article === article);
  if (!found) return { ok: false, reason: `条文が存在しない (${article})` };

  const needle = normalizeForQuote(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return { ok: false, reason: "引用が短すぎる" };

  if (!normalizeForQuote(found.text).includes(needle)) {
    return { ok: false, reason: `引用が条文に無い (${article})` };
  }
  return { ok: true };
}

/** 裁定の監査プロンプト。条文の逐語引用を強制する。 */
export function buildAuditPrompt(rulingText: string, articles: RuleArticle[]): string {
  const rules = articles.map((a) => `[${a.article}]\n${a.text}`).join("\n\n");
  return `あなたはデュエル・マスターズのルール監査官です。

以下の「裁定Q&A」は公式サイトに残っているものですが、改定前の古い内容が混じっています。
現行の「総合ルール」の条文と照らして、裁定の**回答が現行ルールと矛盾しているか**を判定してください。

# 裁定Q&A
${rulingText}

# 総合ルール (関連条文)
${rules}

# 判定の指示
- 矛盾とは、裁定の回答どおりに処理すると総合ルールに違反する場合を指します。
- 裁定が条文より**簡略なだけ**、条文に**書かれていないだけ**は矛盾ではありません (contradicts=false)。
- 上に挙がっていない条文を根拠にしてはいけません。判断できなければ contradicts=false としてください。
- contradicts=true とするときは、必ず矛盾の根拠になる条文を1つ選び、
  - article: その条番号 (例 "501.1") を上のリストからそのまま写す
  - quote: **その条文の本文から逐語でコピーした一節** (言い換え・要約は禁止。原文の文字列をそのまま)
  を返してください。quote が原文と一致しない場合、その判定は破棄されます。`;
}

/** Gemini に渡す responseSchema。数値の下限制約は使わない (Gemini が 400 を返す)。 */
const VERDICT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    contradicts: { type: Type.BOOLEAN },
    article: { type: Type.STRING },
    quote: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["contradicts", "article", "quote", "reason"],
};

const VERDICT_ZOD = z.object({
  contradicts: z.boolean(),
  article: z.string(),
  quote: z.string(),
  reason: z.string(),
});

/** `Q: ...\nA: ...` 形式のチャンクから質問文を取り出す。 */
export function rulingQuestion(chunkText: string): string {
  const m = chunkText.match(/^Q:\s*([\s\S]*?)\n\s*A:/);
  return (m ? m[1] : chunkText).trim();
}

type Sql = ReturnType<typeof getSql>;

/** 監査対象 (カード名を含まない一般ルール裁定) を DB から取る。 */
async function fetchCandidates(sql: Sql, limit?: number): Promise<RulingRow[]> {
  const rows = await sql`
    SELECT id, chunk_meta->>'qa_id' AS qa_id, chunk_text
    FROM rule_chunks
    WHERE doc_type = 'ruling' AND embedding IS NOT NULL
    ORDER BY (chunk_meta->>'qa_id')::int
  `;
  const all = rows.map((r) => ({
    id: Number(r.id),
    qaId: Number(r.qa_id),
    question: rulingQuestion(String(r.chunk_text)),
    text: String(r.chunk_text),
  }));
  const general = all.filter((r) => !isCardSpecific(r.question));
  return limit ? general.slice(0, limit) : general;
}

/**
 * その裁定に近い総合ルール条文を、**保存済みの embedding 同士**で引く。
 * 埋め込み API を呼び直さないので、この段は API コストがゼロ。
 */
async function fetchRelatedArticles(sql: Sql, rulingId: number): Promise<RuleArticle[]> {
  const rows = await sql`
    SELECT r.chunk_meta->>'article' AS article, r.chunk_text
    FROM rule_chunks r, rule_chunks q
    WHERE q.id = ${rulingId}
      AND r.doc_type = 'comprehensive_rules'
      AND r.embedding IS NOT NULL
    ORDER BY r.embedding <=> q.embedding
    LIMIT ${ARTICLES_PER_RULING}
  `;
  return rows
    .filter((r) => r.article)
    .map((r) => ({ article: String(r.article), text: String(r.chunk_text) }));
}

/** 配列を並列度つきで処理する (順序は保持)。 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AuditReport {
  candidates: number;
  judged: number;
  flagged: number;
  rejected: number;
  errors: number;
  contradictions: Contradiction[];
}

export async function runAuditRulings(
  opts: { limit?: number; out?: string } = {},
): Promise<AuditReport> {
  const sql = getSql();
  const candidates = await fetchCandidates(sql, opts.limit);
  console.log(`=== 裁定監査開始: 一般ルール裁定 ${candidates.length}件 ===`);

  const contradictions: Contradiction[] = [];
  let judged = 0;
  let rejected = 0;
  let errors = 0;

  await mapPool(candidates, CONCURRENCY, async (ruling) => {
    const articles = await fetchRelatedArticles(sql, ruling.id);
    if (articles.length === 0) return;

    let verdict: AuditVerdict;
    try {
      verdict = await generateStructured(buildAuditPrompt(ruling.text, articles), VERDICT_ZOD, {
        responseSchema: VERDICT_RESPONSE_SCHEMA,
        temperature: 0, // 監査は再現性を優先する
      });
    } catch (err) {
      errors++;
      console.warn(`  qa_id ${ruling.qaId}: 判定失敗 ${(err as Error).message}`);
      return;
    }
    judged++;

    const check = verifyGrounding(verdict, articles);
    if (!check.ok) {
      // LLM が矛盾と言ったのに裏取りできなかったものは、握りつぶさず数える。
      // ここが多いほど LLM の判定を信用できない (= 閾値やプロンプトを見直す材料)。
      if (verdict.contradicts) {
        rejected++;
        console.warn(`  qa_id ${ruling.qaId}: 却下 (${check.reason})`);
      }
      return;
    }

    contradictions.push({
      qaId: ruling.qaId,
      question: ruling.question,
      article: verdict.article.trim(),
      quote: verdict.quote.trim(),
      reason: verdict.reason.trim(),
    });
    console.log(`  ★ qa_id ${ruling.qaId} は ${verdict.article} と矛盾: ${ruling.question.slice(0, 40)}`);
  });

  contradictions.sort((a, b) => a.qaId - b.qaId);
  const report: AuditReport = {
    candidates: candidates.length,
    judged,
    flagged: contradictions.length,
    rejected,
    errors,
    contradictions,
  };

  if (opts.out) {
    await writeFile(opts.out, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`レポート: ${opts.out}`);
  }
  console.log(
    `=== 監査完了: 対象${report.candidates} / 判定${judged} / 矛盾${report.flagged} / 裏取り失敗で却下${rejected} / エラー${errors} ===`,
  );
  await closeDb();
  return report;
}

/** CLI 引数: [--limit=N] [--out=path]。 */
export function parseAuditArgs(argv: string[]): { limit?: number; out?: string } {
  const opts: { limit?: number; out?: string } = {};
  for (const a of argv) {
    const limit = a.match(/^--limit=(\d+)$/);
    if (limit) opts.limit = parseInt(limit[1], 10);
    const out = a.match(/^--out=(.+)$/);
    if (out) opts.out = out[1];
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuditRulings(parseAuditArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
