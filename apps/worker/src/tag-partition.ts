import { inferTagsByRule } from "@dm-ai/deck-engine";
import type { Card, RoleTag } from "@dm-ai/core";

/** タグ付け対象カード (DB から取得する最小フィールド) */
export interface TaggingCard {
  id: number;
  name: string;
  cost: number;
  text: string;
  power: number | null;
  is_shield_trigger: boolean;
}

/** ルール適用結果でカードを分類する */
export interface TagPartition {
  ruleTagged: Array<{ id: number; tags: RoleTag[] }>;
  needsLlm: TaggingCard[];
}

/** TaggingCard → inferTagsByRule 用の Card (使わないフィールドは既定値) */
function toCard(c: TaggingCard): Card {
  return {
    name: c.name,
    civilizations: [],
    cost: c.cost,
    type: "creature",
    races: [],
    text: c.text,
    power: c.power,
    is_rainbow: false,
    is_shield_trigger: c.is_shield_trigger,
    tags: [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
  };
}

/** ルールでタグが付くカード(ruleTagged)と付かないカード(needsLlm)に分類する */
export function partitionByRule(cards: TaggingCard[]): TagPartition {
  const ruleTagged: Array<{ id: number; tags: RoleTag[] }> = [];
  const needsLlm: TaggingCard[] = [];
  for (const c of cards) {
    const tags = inferTagsByRule(toCard(c));
    if (tags.length > 0) {
      ruleTagged.push({ id: c.id, tags });
    } else {
      needsLlm.push(c);
    }
  }
  return { ruleTagged, needsLlm };
}
