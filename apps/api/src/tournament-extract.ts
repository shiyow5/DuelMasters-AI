import {
  generateStructured,
  Type,
  TournamentExtractionSchema,
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

/** HTML テキストから大会結果を構造化抽出する。抽出不能なら例外 */
export async function extractTournament(
  pageText: string
): Promise<TournamentExtraction> {
  return generateStructured(
    `以下はデュエル・マスターズの大会結果ページのテキストです。` +
      `大会名・開催日(YYYY-MM-DD)・参加者数(不明なら null)・` +
      `デッキアーキタイプ名と順位の一覧を抽出してください。\n\n---\n${pageText.slice(0, 30000)}`,
    TournamentExtractionSchema,
    { responseSchema: RESPONSE_SCHEMA, temperature: 0 }
  );
}
