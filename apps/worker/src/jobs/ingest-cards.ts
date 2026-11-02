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

/**
 * 一覧の並び順。公式サイトのブラウザ側 (search.js) は sort セレクトの値を必ず送り、
 * 初期値は先頭の「発売日の新しい順」(release_new)。ここでも明示して順序を固定する。
 * 差分モードの打ち切り (新規 id の無いページが続いたら終える) は**新しい順であること**が前提。
 */
const LIST_SORT = "release_new";

/** 一覧の1ページ分の id を取得する (POST + Ajax ヘッダが必要)。 */
async function fetchCardListIds(pagenum: number): Promise<string[]> {
  const res = await fetch(CARD_LIST_URL, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ pagenum: String(pagenum), sort: LIST_SORT }).toString(),
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

/**
 * 取り込みモード。
 * - diff (既定・週次): 一覧を新しい順に読み、**DB に無い id だけ**詳細を取る。
 *   DB に無い id が1つも無いページが `stopAfterEmptyPages` ページ続いたら終える。
 * - full (月次の全件更新): ページ範囲内の id をすべて詳細から取り直して upsert する
 *   (テキスト修正・エラッタの反映用)。
 * - list (月次の点検): 一覧だけを最後まで読み、詳細は取らない。DB にしか無い id を数える。
 */
export type CardsMode = "diff" | "full" | "list";

export interface CardsOptions {
  /** upsert した枚数がこれに達したら終える (動作確認用) */
  limit?: number;
  mode?: CardsMode;
  /** 一覧の開始ページ (1始まり) */
  startPage?: number;
  /** 読む一覧ページ数の上限。省略時は一覧の最後まで */
  maxPages?: number;
  /** diff モードの打ち切り条件 (K)。既定 3 */
  stopAfterEmptyPages?: number;
}

/** 新規 id の無いページがこれだけ続いたら差分取り込みを終える */
export const DEFAULT_STOP_AFTER_EMPTY_PAGES = 3;
/** 公式から消えた id をログに並べる上限 (件数は全数を出す) */
const REMOVED_LOG_LIMIT = 50;

export interface CrawlDeps {
  fetchListIds(page: number): Promise<string[]>;
  fetchDetail(id: string): Promise<string>;
  upsert(card: RawCard): Promise<void>;
  /** DB に入っている official_id */
  knownIds: ReadonlySet<string>;
  sleep(ms: number): Promise<void>;
  log?(msg: string): void;
  warn?(msg: string): void;
}

export type CrawlStop =
  | "end" // 一覧の最後まで読んだ
  | "no-new" // diff: 新規 id の無いページが K ページ続いた
  | "max-pages" // ページ範囲の終わり
  | "limit" // limit 枚に達した
  | "list-error"; // 一覧の取得に失敗した

export interface CrawlResult {
  inserted: number;
  pages: number;
  /** 最後に読んだ一覧ページ (1ページも読めなければ startPage - 1) */
  lastPage: number;
  /** 一覧に出てきて DB に無かった id の数 */
  newIds: number;
  stop: CrawlStop;
  /**
   * DB にあって一覧に無かった id。一覧を**1ページ目から最後まで**読めたときだけ計算する
   * (途中で終えたときは判定できないので null)。削除はせずログに出すだけ。
   */
  removedIds: string[] | null;
}

/** DB に無い id だけを返す (純粋関数・テスト対象)。 */
export function selectNewIds(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids.filter((id) => !known.has(id));
}

/**
 * カード一覧を巡回して詳細を取り込む本体。DB と HTTP は deps で差し替えられる (テスト対象)。
 */
export async function crawlCards(deps: CrawlDeps, opts: CardsOptions = {}): Promise<CrawlResult> {
  const mode = opts.mode ?? "diff";
  const startPage = opts.startPage ?? 1;
  const lastAllowed = opts.maxPages ? startPage + opts.maxPages - 1 : Infinity;
  const stopAfter = opts.stopAfterEmptyPages ?? DEFAULT_STOP_AFTER_EMPTY_PAGES;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  const seen = new Set<string>();
  let inserted = 0;
  let pages = 0;
  let newIds = 0;
  let emptyStreak = 0;
  let lastPage = startPage - 1;
  let stop: CrawlStop = "max-pages";

  pageLoop: for (let page = startPage; page <= lastAllowed; page++) {
    let ids: string[];
    try {
      ids = await deps.fetchListIds(page);
    } catch (err) {
      warn(`ページ ${page} 一覧取得失敗: ${(err as Error).message}`);
      stop = "list-error";
      break;
    }
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) {
      // 最終ページの先は空 (または同じ id の繰り返し) が返る
      stop = "end";
      break;
    }
    pages++;
    lastPage = page;
    for (const id of fresh) seen.add(id);

    const unknown = selectNewIds(fresh, deps.knownIds);
    newIds += unknown.length;
    const targets = mode === "full" ? fresh : mode === "diff" ? unknown : [];

    for (const id of targets) {
      try {
        const card = parseCardDetail(await deps.fetchDetail(id), id);
        if (card) {
          await deps.upsert(card);
          inserted++;
        }
      } catch (err) {
        warn(`カード ${id} 取得失敗: ${(err as Error).message}`);
      }
      if (opts.limit && inserted >= opts.limit) {
        stop = "limit";
        break pageLoop;
      }
      await deps.sleep(DELAY_MS);
    }
    log(`  ページ ${page}: 新規 ${unknown.length}件 / 累計 ${inserted}枚`);

    if (mode === "diff") {
      emptyStreak = unknown.length === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= stopAfter) {
        stop = "no-new";
        break;
      }
    }
    // 詳細を取らないページが続いても公式サイトに連打しない
    if (targets.length === 0) await deps.sleep(DELAY_MS);
  }

  const removedIds =
    stop === "end" && startPage === 1 ? [...deps.knownIds].filter((id) => !seen.has(id)) : null;
  if (removedIds && removedIds.length > 0) {
    const shown = removedIds.slice(0, REMOVED_LOG_LIMIT).join(", ");
    const more = removedIds.length > REMOVED_LOG_LIMIT ? " ほか" : "";
    // 削除はしない。公式から一時的に消えただけのこともあり、勝手に消すと本番データが壊れる。
    warn(`公式の一覧に無い DB の id: ${removedIds.length}件 (削除はしない): ${shown}${more}`);
  }
  return { inserted, pages, lastPage, newIds, stop, removedIds };
}

export async function runIngestCards(opts: CardsOptions = {}): Promise<CrawlResult> {
  const mode = opts.mode ?? "diff";
  const range = `ページ ${opts.startPage ?? 1}〜${opts.maxPages ? (opts.startPage ?? 1) + opts.maxPages - 1 : "最後"}`;
  console.log(`=== カードデータ取り込み開始 (mode=${mode}, ${range}) ===`);
  const sql = getSql();
  try {
    const rows = await sql<{ official_id: string }[]>`
      SELECT official_id FROM cards WHERE official_id IS NOT NULL
    `;
    const knownIds = new Set(rows.map((r) => r.official_id));
    console.log(`  DB の既知 id: ${knownIds.size}件`);
    const result = await crawlCards(
      {
        fetchListIds: fetchCardListIds,
        fetchDetail: (id) => fetchWithRetry(`${BASE_URL}/card/detail/?id=${id}`),
        upsert: (card) => upsertCard(sql, card),
        knownIds,
        sleep,
      },
      opts,
    );
    console.log(
      `=== カードデータ取り込み完了 (${result.stop}): ${result.inserted}枚 / ${result.pages}ページ` +
        ` (最終ページ ${result.lastPage}, 一覧で見つかった新規 id ${result.newIds}件) ===`,
    );
    return result;
  } finally {
    await closeDb();
  }
}

/** 正の整数の引数を読む。不正なら例外 (黙って全件取り込みに倒さないため)。 */
function positiveInt(flag: string, value: string | undefined): number {
  const n = value !== undefined && /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${flag} には正の整数を指定してください: ${value}`);
  return n;
}

/**
 * CLI 引数 (純粋関数・テスト対象)。
 * `[limit] [--full | --list-only] [--start-page N] [--max-pages M]`。
 * limit は従来どおり先頭の数値 (省略時は制限なし)。
 */
export function parseCardsArgs(argv: string[]): CardsOptions {
  const opts: CardsOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start-page") opts.startPage = positiveInt(a, argv[++i]);
    else if (a === "--max-pages") opts.maxPages = positiveInt(a, argv[++i]);
    else if (a === "--full") opts.mode = "full";
    else if (a === "--list-only") opts.mode = "list";
    else if (i === 0 && /^\d+$/.test(a) && parseInt(a, 10) > 0) opts.limit = parseInt(a, 10);
    else throw new Error(`不明な引数: ${a}`);
  }
  if (argv.includes("--full") && argv.includes("--list-only")) {
    throw new Error("--full と --list-only は同時に指定できません");
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts: CardsOptions;
  try {
    opts = parseCardsArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "使用法: tsx src/jobs/ingest-cards.ts [limit] [--full | --list-only] [--start-page N] [--max-pages M]",
    );
    process.exit(1);
  }
  runIngestCards(opts)
    // 1ページも読めずに終わったときだけ失敗にする。最終ページの先がエラーで返る可能性もあるので、
    // 途中のページでの一覧取得失敗は従来どおり warning で終える。
    .then((r) => process.exit(r.stop === "list-error" && r.pages === 0 ? 1 : 0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
