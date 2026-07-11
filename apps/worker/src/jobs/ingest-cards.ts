/**
 * カードデータ取り込みジョブ
 * 公式カードDBからスクレイピング → DB格納
 */
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { CIVILIZATIONS } from "@dm-ai/core";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { sleep, fetchWithRetry } from "../lib.js";
import { normalizeCardType } from "../card-type-map.js";

const BASE_URL = OFFICIAL_SITE_BASE_URL;
const CARD_LIST_URL = `${BASE_URL}/card/`;
const CONCURRENT_LIMIT = 3;
const DELAY_MS = 1000;

interface RawCard {
  name: string;
  civilizations: string[];
  cost: number;
  type: string;
  races: string[];
  text: string;
  power: number | null;
  rarity: string | null;
  set_code: string | null;
  official_id: string;
  card_image_url: string | null;
  is_rainbow: boolean;
  is_shield_trigger: boolean;
}

async function main() {
  console.log("=== カードデータ取り込み開始 ===");

  const sql = getSql();

  // カード一覧ページを走査
  let page = 1;
  let totalCards = 0;
  let hasMore = true;

  while (hasMore) {
    console.log(`ページ ${page} 取得中...`);

    try {
      const listUrl = `${CARD_LIST_URL}?page=${page}`;
      const html = await fetchWithRetry(listUrl);
      const $ = cheerio.load(html);

      const cardLinks: string[] = [];
      $("a[href*='/card/detail/']").each((_, el) => {
        const href = $(el).attr("href");
        if (href) cardLinks.push(href.startsWith("http") ? href : `${BASE_URL}${href}`);
      });

      if (cardLinks.length === 0) {
        hasMore = false;
        break;
      }

      // 並列数制限で詳細ページを取得
      for (let i = 0; i < cardLinks.length; i += CONCURRENT_LIMIT) {
        const batch = cardLinks.slice(i, i + CONCURRENT_LIMIT);
        const cards = await Promise.allSettled(
          batch.map((url) => scrapeCardDetail(url))
        );

        for (const result of cards) {
          if (result.status === "fulfilled" && result.value) {
            await upsertCard(sql, result.value);
            totalCards++;
          } else if (result.status === "rejected") {
            console.error("カード取得エラー:", result.reason);
          }
        }

        await sleep(DELAY_MS);
      }

      page++;
    } catch (err) {
      console.error(`ページ ${page} エラー:`, err);
      hasMore = false;
    }
  }

  console.log(`=== カードデータ取り込み完了: ${totalCards}枚 ===`);
  await closeDb();
}

async function scrapeCardDetail(url: string): Promise<RawCard | null> {
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  const name = $(".cardName").text().trim();
  if (!name) return null;

  const costText = $(".cardCost").text().trim();
  const cost = parseInt(costText, 10) || 0;

  const typeText = $(".cardType").text().trim();
  const raceText = $(".cardRace").text().trim();
  const cardText = $(".cardText").text().trim();
  const powerText = $(".cardPower").text().trim();

  const civElements = $(".civilization");
  const civilizations: string[] = [];
  civElements.each((_, el) => {
    const civClass = $(el).attr("class") ?? "";
    for (const civ of CIVILIZATIONS) {
      if (civClass.includes(civ)) civilizations.push(civ);
    }
  });

  const imageUrl = $(".cardImage img").attr("src") ?? null;
  const officialId = new URL(url).searchParams.get("id");
  if (!officialId) {
    console.warn(`official_id が取得できないためスキップ: ${url}`);
    return null;
  }

  const type = normalizeCardType(typeText);
  if (!type) {
    console.warn(
      `未知のカード種別 "${typeText}" のため creature として格納: ${url}`
    );
  }

  return {
    name,
    civilizations,
    cost,
    type: type ?? "creature",
    races: raceText ? raceText.split("/").map((r) => r.trim()) : [],
    text: cardText,
    power: powerText ? parseInt(powerText.replace(/\+/, ""), 10) || null : null,
    rarity: $(".cardRarity").text().trim() || null,
    set_code: $(".cardSet").text().trim() || null,
    official_id: officialId,
    card_image_url: imageUrl
      ? imageUrl.startsWith("http")
        ? imageUrl
        : `${BASE_URL}${imageUrl}`
      : null,
    is_rainbow: civilizations.length >= 2,
    is_shield_trigger: cardText.includes("S・トリガー") || cardText.includes("Ｓ・トリガー"),
  };
}

async function upsertCard(
  sql: ReturnType<typeof getSql>,
  card: RawCard
): Promise<void> {
  await sql`
    INSERT INTO cards (
      name, civilizations, cost, type, races, text, power,
      is_rainbow, is_shield_trigger, card_image_url, official_id,
      set_code, rarity, updated_at
    ) VALUES (
      ${card.name},
      ${sql.json(card.civilizations)},
      ${card.cost},
      ${card.type},
      ${sql.json(card.races)},
      ${card.text},
      ${card.power},
      ${card.is_rainbow},
      ${card.is_shield_trigger},
      ${card.card_image_url},
      ${card.official_id},
      ${card.set_code},
      ${card.rarity},
      NOW()
    )
    ON CONFLICT (official_id) DO UPDATE SET
      name = EXCLUDED.name,
      civilizations = EXCLUDED.civilizations,
      cost = EXCLUDED.cost,
      type = EXCLUDED.type,
      races = EXCLUDED.races,
      text = EXCLUDED.text,
      power = EXCLUDED.power,
      is_rainbow = EXCLUDED.is_rainbow,
      is_shield_trigger = EXCLUDED.is_shield_trigger,
      card_image_url = EXCLUDED.card_image_url,
      set_code = EXCLUDED.set_code,
      rarity = EXCLUDED.rarity,
      updated_at = NOW()
  `;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
