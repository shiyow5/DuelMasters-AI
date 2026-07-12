import { generateStructured, Type } from "@dm-ai/core";
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
 * LLM-as-judge。回答を採点基準 (rubric) に対して 1-5 で採点する。
 * 再現性のため temperature=0。判定モデルは core の構造化チェーン (Gemini 系) を使う。
 */
export async function judgeAnswer(
  question: string,
  rubric: string,
  response: string,
): Promise<Judgement> {
  const prompt = [
    "あなたはデュエル・マスターズに精通した厳格な採点者です。",
    "以下の回答を、採点基準に照らして 1〜5 で採点してください。",
    "1=誤り/無関係, 2=不十分, 3=概ね妥当, 4=正確で有用, 5=完全に正確かつ根拠明快。",
    "ハルシネーション(存在しないルール/カードの捏造)があれば大きく減点してください。",
    "",
    `# 質問\n${question}`,
    `# 採点基準\n${rubric}`,
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
