import {
  generateStructured,
  Type,
  TournamentExtractionSchema,
  normalizeEventName,
  partitionValidArchetypes,
  type TournamentExtraction,
} from "@dm-ai/core";

/** TournamentExtractionSchema に対応する Gemini responseSchema */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    event_name: { type: Type.STRING },
    event_date: { type: Type.STRING, description: "YYYY-MM-DD 形式" },
    participants: { type: Type.NUMBER, nullable: true },
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          deck_archetype: { type: Type.STRING },
          placement: { type: Type.NUMBER },
        },
      },
    },
  },
};

/**
 * 抽出結果を取込み前に検証する (#254 M-3 ②)。
 *
 * アーキタイプ名・大会名は LLM がページから抜いた文字列で、DB に入ると回答の材料と UI に出る。
 * URL・改行・長文を含む**行はスキップ**して件数を警告に出す (取込み全体は失敗させない)。
 * 大会名が不合格、または有効な行が 0 件のときは取り込めないので例外にする (route は 422 を返す)。
 */
export function validateExtraction(extracted: TournamentExtraction): TournamentExtraction {
  const eventName = normalizeEventName(extracted.event_name);
  if (eventName === null) throw new Error("大会名が検証を通らない");
  const { valid, rejected } = partitionValidArchetypes(extracted.results);
  if (rejected > 0) {
    console.warn(
      `[api/meta] アーキタイプ名の検証で ${rejected}/${extracted.results.length} 件をスキップ`,
    );
  }
  if (valid.length === 0) throw new Error("検証を通るアーキタイプ名が 0 件");
  return { ...extracted, event_name: eventName, results: valid };
}

/** HTML テキストから大会結果を構造化抽出する。抽出不能なら例外 */
export async function extractTournament(pageText: string): Promise<TournamentExtraction> {
  const extracted = await generateStructured(
    `以下はデュエル・マスターズの大会結果ページのテキストです。` +
      `大会名・開催日(YYYY-MM-DD)・参加者数(不明なら null)・` +
      `デッキアーキタイプ名と順位の一覧を抽出してください。\n\n---\n${pageText.slice(0, 30000)}`,
    TournamentExtractionSchema,
    { responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  );
  return validateExtraction(extracted);
}
