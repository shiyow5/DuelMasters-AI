import { generateStructured, Type } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import { searchRules } from "@dm-ai/rag";
import { z } from "zod";

const JudgeSchema = z.object({
  score: z.number().min(1).max(5),
  reason: z.string(),
});

export interface Judgement {
  score: number;
  reason: string;
}

/**
 * 回答からカード名候補を抽出する (純粋関数・テスト対象)。
 * DM のカード名は《…》/「…」で表記されることが多いのでそれを拾う。
 * 2〜40 文字、重複除去。
 */
export function extractCardCandidates(response: string): string[] {
  const names = new Set<string>();
  for (const m of response.matchAll(/[《「]([^》」]{2,40})[》」]/g)) {
    const n = m[1].trim();
    if (n) names.add(n);
  }
  return [...names];
}

/** 逆引きで拾うカード名の最小長。短すぎる名前が地の文に偶然一致するのを避ける。 */
const MIN_NAME_LEN = 3;
/** grounding に載せる実在カードの上限 (プロンプト肥大の防止)。 */
const MAX_CONFIRMED = 60;

/**
 * judge に渡す「カード実在性」grounding を作る。
 * LLM-as-judge はカードプール (11563枚) を知らず、実在カードを「架空」と誤判定しがち。
 *
 * 実在判定は **DB のカード名を回答本文へ逆引き** して行う。回答からカード名を抽出する方式だと
 * 《…》表記しか拾えず、素のデッキリスト (例: "4x 最期の竜炎") が grounding から漏れて
 * judge が従来どおり推測で減点してしまうため。逆引きなら表記に依存しない。
 * 《…》で明示された名前のうち逆引きに掛からなかったものだけを「捏造の疑い」として挙げる。
 *
 * DB 障害時は空文字を返し (grounding 無しで続行)、judge を落とさない。
 */
export async function buildCardGrounding(response: string): Promise<string> {
  if (!response.trim()) return "";
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT name FROM cards
      WHERE length(name) >= ${MIN_NAME_LEN} AND ${response} ILIKE '%' || name || '%'
      ORDER BY length(name) DESC
      LIMIT ${MAX_CONFIRMED}
    `;
    const confirmed = rows.map((r) => r.name as string);

    // 明示表記の候補のうち、実在カード名と全く重ならないものは捏造の疑い。
    const suspicious = extractCardCandidates(response).filter(
      (c) => !confirmed.some((n) => c.includes(n) || n.includes(c)),
    );

    if (confirmed.length === 0 && suspicious.length === 0) return "";
    const lines: string[] = ["# カード実在性 grounding (カードDB照合)"];
    if (confirmed.length)
      lines.push(`回答中に登場し実在が確認できたカード: ${confirmed.join(", ")}`);
    if (suspicious.length)
      lines.push(`DB未検出 (表記揺れ or 架空の可能性): ${suspicious.join(", ")}`);
    lines.push(
      "実在確認済みのカードを『存在しない』と決めつけて減点しないこと。DB未検出でも表記揺れの可能性があるため、明らかに不自然 (ランダム文字列等) な場合のみ捏造として減点すること。",
    );
    return lines.join("\n");
  } catch (err) {
    if (process.env.JUDGE_DEBUG) console.error("[buildCardGrounding]", (err as Error).message);
    return "";
  }
}

/** judge に渡す公式裁定の最大件数。 */
const MAX_RULINGS = 5;

/**
 * 質問に関連する公式裁定を RAG で引き、judge に渡す grounding 文を作る。
 *
 * judge (LLM) は DM のルール知識も誤る。実測では「単色カードの召喚に文明一致は不要」
 * 「マナはコスト以上を支払ってよい」といった、公式裁定が明確に否定する主張を根拠に
 * 正答を減点した。judge の記憶ではなく一次情報 (取込済みの公式裁定 3246件) を
 * 判断根拠にさせるため、質問に関連する裁定を添える。
 *
 * 失敗時は空文字を返し (grounding 無しで続行)、judge を落とさない。
 */
export async function buildRuleGrounding(question: string): Promise<string> {
  try {
    const result = await searchRules(question);
    const chunks = result.chunks.slice(0, MAX_RULINGS);
    if (chunks.length === 0) return "";
    const lines = ["# 公式裁定 (一次情報。ルールの正誤はこれを根拠とすること)"];
    chunks.forEach((ch, i) => {
      lines.push(`[裁定${i + 1}] ${ch.text.replace(/\s+/g, " ").slice(0, 400)}`);
    });
    lines.push(
      "上記の公式裁定に反する判断をあなた自身の記憶で下さないこと。裁定に無い論点は、回答の内容だけで判断すること。",
    );
    return lines.join("\n");
  } catch (err) {
    if (process.env.JUDGE_DEBUG) console.error("[buildRuleGrounding]", (err as Error).message);
    return "";
  }
}

/**
 * LLM-as-judge。回答を採点基準 (rubric) に対して 1-5 で採点する。
 * 再現性のため temperature=0。判定モデルは core の構造化チェーン (Gemini 系) を使う。
 *
 * judge 自身のハルシネーションを 2 系統の grounding で抑える:
 * - カード実在性: 回答本文に登場する実在カードを DB 逆引きして提示 (buildCardGrounding)
 * - ルールの正誤: 質問に関連する公式裁定を RAG で提示 (buildRuleGrounding)
 */
export async function judgeAnswer(
  question: string,
  rubric: string,
  response: string,
): Promise<Judgement> {
  const [cardGrounding, ruleGrounding] = await Promise.all([
    buildCardGrounding(response),
    buildRuleGrounding(question),
  ]);
  const prompt = [
    "あなたはデュエル・マスターズに精通した厳格な採点者です。",
    "以下の『回答』を、『採点基準』に照らして 1〜5 で採点してください。",
    "1=誤り/無関係, 2=不十分, 3=概ね妥当, 4=正確で有用, 5=完全に正確かつ根拠明快。",
    "",
    "採点の鉄則:",
    "- 採点対象は『回答』の記述だけである。『採点基準』に書かれた内容を『回答』の主張と取り違えないこと。",
    "- ルールの正誤は下記の公式裁定を根拠とすること。裁定に反する判断をあなた自身の記憶で下さないこと。",
    "- カードの実在性は下記の grounding を根拠とすること。あなたが知らないだけのカードを架空と決めつけないこと。",
    "- 上記を踏まえてなお、存在しないルール/カードの捏造があれば大きく減点すること。",
    "",
    `# 質問\n${question}`,
    `# 採点基準\n${rubric}`,
    ruleGrounding ? ruleGrounding + "\n" : "",
    cardGrounding ? cardGrounding + "\n" : "",
    `# 回答\n${response}`,
  ].join("\n");

  return generateStructured(prompt, JudgeSchema, {
    responseSchema: {
      type: Type.OBJECT,
      properties: { score: { type: Type.NUMBER }, reason: { type: Type.STRING } },
      required: ["score", "reason"],
    },
    temperature: 0,
  });
}
