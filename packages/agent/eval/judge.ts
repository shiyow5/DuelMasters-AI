import { generateStructured, Type } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
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

/**
 * 抽出したカード名候補を DB で実在確認し、judge に渡す grounding 文を作る。
 * LLM-as-judge はカードプールを知らず実在カードを「架空」と誤判定しがちなため、
 * 実在確認済み / DB 未検出 を明示して捏造判定の根拠を与える。
 * DB 障害時は空文字を返し (grounding 無しで続行)、judge を落とさない。
 */
export async function buildCardGrounding(response: string): Promise<string> {
  const candidates = extractCardCandidates(response);
  if (candidates.length === 0) return "";
  try {
    const sql = getSql();
    // まず完全一致をまとめて確認 (1 クエリ)。
    const exactRows = await sql`SELECT DISTINCT name FROM cards WHERE name IN ${sql(candidates)}`;
    const exactNames = new Set(exactRows.map((r) => r.name as string));
    const ok: string[] = [];
    const miss: string[] = [];
    for (const c of candidates) {
      if (exactNames.has(c)) {
        ok.push(c);
        continue;
      }
      // 未一致のみ表記揺れ (双方向部分一致) を確認。
      // 逆方向 (候補がカード名を含む) は、短いカード名が偶然部分一致して誤って
      // 「実在」と判定するのを避けるため、4文字以上のカード名に限る。
      const fuzzy = await sql`
        SELECT 1 FROM cards
        WHERE name ILIKE ${"%" + c + "%"}
           OR (length(name) >= 4 AND ${c} ILIKE '%' || name || '%')
        LIMIT 1
      `;
      (fuzzy.length ? ok : miss).push(c);
    }
    const lines: string[] = ["# カード実在性 grounding (カードDB照合)"];
    if (ok.length) lines.push(`実在確認済み: ${ok.join(", ")}`);
    if (miss.length) lines.push(`DB未検出 (表記揺れ or 架空の可能性): ${miss.join(", ")}`);
    lines.push(
      "実在確認済みのカードを『存在しない』と決めつけて減点しないこと。DB未検出でも表記揺れの可能性があるため、明らかに不自然 (ランダム文字列等) な場合のみ捏造として減点すること。",
    );
    return lines.join("\n");
  } catch (err) {
    if (process.env.JUDGE_DEBUG) console.error("[buildCardGrounding]", (err as Error).message);
    return "";
  }
}

/**
 * LLM-as-judge。回答を採点基準 (rubric) に対して 1-5 で採点する。
 * 再現性のため temperature=0。判定モデルは core の構造化チェーン (Gemini 系) を使う。
 * カード名は事前に DB 照合し、judge の実在性ハルシネーションを抑える。
 */
export async function judgeAnswer(
  question: string,
  rubric: string,
  response: string,
): Promise<Judgement> {
  const grounding = await buildCardGrounding(response);
  const prompt = [
    "あなたはデュエル・マスターズに精通した厳格な採点者です。",
    "以下の回答を、採点基準に照らして 1〜5 で採点してください。",
    "1=誤り/無関係, 2=不十分, 3=概ね妥当, 4=正確で有用, 5=完全に正確かつ根拠明快。",
    "ハルシネーション(存在しないルール/カードの捏造)があれば大きく減点してください。",
    "ただしカードの実在性は下記 grounding を根拠とし、あなたが知らないだけのカードを架空と決めつけないこと。",
    "",
    `# 質問\n${question}`,
    `# 採点基準\n${rubric}`,
    grounding ? grounding + "\n" : "",
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
