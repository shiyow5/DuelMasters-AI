/**
 * カード役割タグ付与ジョブ (ルール → LLM フォールバック)。
 * ルールで1個以上付けば採用、0個のカードのみ Gemini でまとめて推定する。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import {
  generateStructured,
  Type,
  ROLE_TAGS,
  TagExtractionSchema,
  type RoleTag,
} from "@dm-ai/core";
import { partitionByRule, type TaggingCard } from "../tag-partition.js";
import { sleep } from "../lib.js";

const LLM_BATCH_SIZE = 20;

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING },
      tags: {
        type: Type.ARRAY,
        items: { type: Type.STRING, enum: [...ROLE_TAGS] },
      },
    },
  },
};

const ROLE_TAG_DESC = `役割タグの定義:
- 初動: コスト3以下でマナ加速やドローができる序盤札
- 受け: S・トリガー/ブロッカー等の防御札
- 除去: 相手のクリーチャーを破壊/バウンス/マナ送り等で処理する
- ドロー: カードを引く
- フィニッシャー: 高コストの決め手 (Wブレイカー以上/高パワー)
- メタ: 相手の行動を制約する
- ブースト: マナを加速する`;

/** needs-llm カードを LLM でタグ推定する (バッチ、name → tags) */
async function tagByLlm(cards: TaggingCard[]): Promise<Map<number, RoleTag[]>> {
  const result = new Map<number, RoleTag[]>();
  const idByName = new Map(cards.map((c) => [c.name, c.id]));

  for (let i = 0; i < cards.length; i += LLM_BATCH_SIZE) {
    const batch = cards.slice(i, i + LLM_BATCH_SIZE);
    const prompt =
      `${ROLE_TAG_DESC}\n\n以下の各カードに当てはまる役割タグを推定してください。該当が無ければ空配列にしてください。\n\n` +
      batch
        .map(
          (c) =>
            `- 名前: ${c.name} / コスト: ${c.cost} / パワー: ${c.power ?? "-"}\n  テキスト: ${c.text}`
        )
        .join("\n");

    const extracted = await generateStructured(prompt, TagExtractionSchema, {
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    });
    for (const item of extracted) {
      const id = idByName.get(item.name);
      if (id !== undefined) result.set(id, item.tags);
    }
    if (i + LLM_BATCH_SIZE < cards.length) await sleep(500);
  }
  return result;
}

export async function runIngestTags(
  opts: { onlyEmpty?: boolean } = {}
): Promise<{ ruleCount: number; llmCount: number; emptyCount: number }> {
  const onlyEmpty = opts.onlyEmpty ?? true;
  console.log(
    `=== タグ付与開始 (対象: ${onlyEmpty ? "タグ未設定のみ" : "全カード"}) ===`
  );
  const sql = getSql();

  const rows = onlyEmpty
    ? await sql`SELECT id, name, cost, text, power, is_shield_trigger FROM cards WHERE jsonb_array_length(tags) = 0`
    : await sql`SELECT id, name, cost, text, power, is_shield_trigger FROM cards`;

  const cards: TaggingCard[] = rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    cost: (r.cost as number) ?? 0,
    text: (r.text as string) ?? "",
    power: (r.power as number) ?? null,
    is_shield_trigger: (r.is_shield_trigger as boolean) ?? false,
  }));

  const { ruleTagged, needsLlm } = partitionByRule(cards);

  for (const { id, tags } of ruleTagged) {
    await sql`UPDATE cards SET tags = ${sql.json(tags)}, updated_at = NOW() WHERE id = ${id}`;
  }

  const llmTags = needsLlm.length > 0 ? await tagByLlm(needsLlm) : new Map();
  let llmCount = 0;
  let emptyCount = 0;
  for (const c of needsLlm) {
    const tags = (llmTags.get(c.id) ?? []) as RoleTag[];
    if (tags.length > 0) {
      await sql`UPDATE cards SET tags = ${sql.json(tags)}, updated_at = NOW() WHERE id = ${c.id}`;
      llmCount++;
    } else {
      emptyCount++;
    }
  }

  console.log(
    `=== タグ付与完了: ルール ${ruleTagged.length}件 / LLM ${llmCount}件 / タグ無し ${emptyCount}件 ===`
  );
  await closeDb();
  return { ruleCount: ruleTagged.length, llmCount, emptyCount };
}

// CLI として直接実行された場合のみ動かす (テストからの import では実行しない)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestTags({ onlyEmpty: !process.argv.includes("--all") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
