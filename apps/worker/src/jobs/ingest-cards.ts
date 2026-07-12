/**
 * カードデータ取り込みジョブ。
 * 公式サイト刷新後 (WordPress + JS レンダリング) の構造に対応:
 * - 一覧/ページング: POST /card/ に pagenum を送り (X-Requested-With: XMLHttpRequest)、
 *   返る HTML 断片から data-href='/card/detail/?id=...' の id を集める。
 * - 詳細: GET /card/detail/?id=ID は静的 HTML。td.cost/td.civil/td.type/td.power/td.race/
 *   td.rarelity と og:title(名前/セット)・meta description(テキスト)・og:image(画像)から抽出。
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { sleep, fetchWithRetry } from "../lib.js";
import { normalizeCardType } from "../card-type-map.js";

const BASE_URL = OFFICIAL_SITE_BASE_URL;
const CARD_LIST_URL = `${BASE_URL}/card/`;
const DELAY_MS = 300;

/** 公式サイトの文明表記 → 内部コード。 */
const CIV_JP: Record<string, string> = {
  火: "fire",
  水: "water",
  自然: "nature",
  光: "light",
  闇: "darkness",
};

export interface RawCard {
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

/** 詳細ページ HTML からカード情報を抽出する (純粋関数・テスト対象)。 */
export function parseCardDetail(html: string, id: string): RawCard | null {
  const $ = cheerio.load(html);
  const ogTitle = ($('meta[property="og:title"]').attr("content") ?? "").split("|")[0].trim();
  if (!ogTitle) return null;
  // 例: "ヨミジ 丁-二式(DMRP12 22/104)" → 名前 + セット情報
  const setMatch = ogTitle.match(/[（(]([^）)]+)[）)]\s*$/);
  const setCode = setMatch ? setMatch[1].split(/\s+/)[0] || null : null;
  const name = ogTitle.replace(/[（(][^）)]+[）)]\s*$/, "").trim();
  if (!name) return null;

  const civText = $("td.civil").first().text().trim();
  const civilizations: string[] = [];
  for (const part of civText.split(/[/／]/)) {
    const c = CIV_JP[part.trim()];
    if (c && !civilizations.includes(c)) civilizations.push(c);
  }

  const cost = parseInt($("td.cost").first().text().trim(), 10) || 0;
  const powerText = $("td.power").first().text().trim();
  const power =
    powerText && powerText !== "-"
      ? parseInt(powerText.replace(/[+＋,，]/g, ""), 10) || null
      : null;
  const raceText = $("td.race").first().text().trim();
  const typeText = $("td.type").first().text().trim();
  const text = (
    $('meta[name="description"]').attr("content") ??
    $('meta[property="og:description"]').attr("content") ??
    ""
  ).trim();

  return {
    name,
    civilizations,
    cost,
    type: normalizeCardType(typeText) ?? "creature",
    races:
      raceText && raceText !== "-"
        ? raceText
            .split(/[/／]/)
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
    text,
    power,
    rarity: $("td.rarelity").first().text().trim() || null,
    set_code: setCode,
    official_id: id,
    card_image_url: $('meta[property="og:image"]').attr("content") ?? null,
    is_rainbow: civilizations.length >= 2,
    is_shield_trigger: text.includes("S・トリガー") || text.includes("Ｓ・トリガー"),
  };
}

/** カード id を data-href/href から取り出す (純粋関数・テスト対象)。 */
export function extractCardIds(html: string): string[] {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $("a[data-href*='/card/detail/'], a[href*='/card/detail/']").each((_, el) => {
    const href = $(el).attr("data-href") ?? $(el).attr("href") ?? "";
    const m = href.match(/id=([^&'"]+)/);
    if (m) ids.add(m[1]);
  });
  return [...ids];
}

/** 一覧の1ページ分の id を取得する (POST + Ajax ヘッダが必要)。 */
async function fetchCardListIds(pagenum: number): Promise<string[]> {
  const res = await fetch(CARD_LIST_URL, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ pagenum: String(pagenum) }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractCardIds(await res.text());
}

async function upsertCard(sql: ReturnType<typeof getSql>, card: RawCard): Promise<void> {
  await sql`
    INSERT INTO cards (
      name, civilizations, cost, type, races, text, power,
      is_rainbow, is_shield_trigger, card_image_url, official_id,
      set_code, rarity, updated_at
    ) VALUES (
      ${card.name}, ${sql.json(card.civilizations)}, ${card.cost}, ${card.type},
      ${sql.json(card.races)}, ${card.text}, ${card.power}, ${card.is_rainbow},
      ${card.is_shield_trigger}, ${card.card_image_url}, ${card.official_id},
      ${card.set_code}, ${card.rarity}, NOW()
    )
    ON CONFLICT (official_id) DO UPDATE SET
      name = EXCLUDED.name, civilizations = EXCLUDED.civilizations, cost = EXCLUDED.cost,
      type = EXCLUDED.type, races = EXCLUDED.races, text = EXCLUDED.text, power = EXCLUDED.power,
      is_rainbow = EXCLUDED.is_rainbow, is_shield_trigger = EXCLUDED.is_shield_trigger,
      card_image_url = EXCLUDED.card_image_url, set_code = EXCLUDED.set_code,
      rarity = EXCLUDED.rarity, updated_at = NOW()
  `;
}

export async function runIngestCards(
  opts: { limit?: number } = {},
): Promise<{ inserted: number; pages: number }> {
  console.log("=== カードデータ取り込み開始 ===");
  const sql = getSql();
  const seen = new Set<string>();
  let inserted = 0;
  let pages = 0;

  for (let page = 1; ; page++) {
    let ids: string[];
    try {
      ids = await fetchCardListIds(page);
    } catch (err) {
      console.warn(`ページ ${page} 一覧取得失敗: ${(err as Error).message}`);
      break;
    }
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) break; // 新しい id が無くなったら終端
    pages++;

    for (const id of fresh) {
      seen.add(id);
      try {
        const html = await fetchWithRetry(`${BASE_URL}/card/detail/?id=${id}`);
        const card = parseCardDetail(html, id);
        if (card) {
          await upsertCard(sql, card);
          inserted++;
        }
      } catch (err) {
        console.warn(`カード ${id} 取得失敗: ${(err as Error).message}`);
      }
      if (opts.limit && inserted >= opts.limit) {
        console.log(`=== カード取り込み完了 (limit): ${inserted}枚 / ${pages}ページ ===`);
        await closeDb();
        return { inserted, pages };
      }
      await sleep(DELAY_MS);
    }
    console.log(`  ページ ${page}: 累計 ${inserted}枚`);
  }

  console.log(`=== カードデータ取り込み完了: ${inserted}枚 / ${pages}ページ ===`);
  await closeDb();
  return { inserted, pages };
}

/** CLI 引数: [limit]。省略時は全件。 */
export function parseCardsArgs(argv: string[]): { limit?: number } {
  const n = argv[0] ? parseInt(argv[0], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? { limit: n } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestCards(parseCardsArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
