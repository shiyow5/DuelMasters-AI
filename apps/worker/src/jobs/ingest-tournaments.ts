/**
 * 大会結果 (CS) 取り込みジョブ。取込元は「田園補完計画 第十七次中間報告書」(supersolenoid.jp)。
 *
 * 取込元の選定 (2026-07 調査):
 * - DMvault は 2025-05-06 に閉鎖済み。
 * - DMP ランキングは順位が載る詳細ページ (event.asp) が robots.txt で Disallow。
 * - 公式サイト /coverage/ は DMGP 級のみ (年数回) で、アーキタイプ名のタグも無い。
 * - ガチまとめは CS 結果記事が 2020 年で止まっている。
 * - 田園補完計画は robots.txt が取込を許可 (Disallow は /tb.php/ のみ)、静的 HTML、
 *   そして記事タイトル自体が構造化されているため LLM 抽出が要らない。
 *
 * 2種類の記事を役割を分けて取り込む:
 *
 * 1. 週次ランキング記事 (フォーマットごとに週1本) → archetype_weekly_stats
 *    「オリジナルCS入賞数ランキング(7/6～7/12)」。母数と全アーキタイプの入賞数が載る。
 *    **ティア表はこちらを一次ソースにする。**
 *
 * 2. 個別 CS 記事 → tournament_results
 *    「【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果 白緑ウィリデが優勝 …」。
 *    タイトルだけで大会名・日付・順位・アーキタイプが揃う。
 *    **これをティア表の母集団には使わない。** ブログが記事にする CS は集計している母集団の一部
 *    でしかなく (実測 2026/7/6〜7/12 オリジナル: 記事 44件 vs 母数 274件)、そのまま数えると
 *    「記事になった CS」に偏った標本になる。あくまで「直近どの大会で入賞したか」の履歴に使う。
 *
 * 取込マナー: 週1の cron、リクエスト間に 1 秒のウェイト、識別可能な User-Agent。
 * 一覧ページのタイトルだけで CS 結果が取れるので、個別記事は原則 fetch しない
 * (週次ランキング記事の本文だけ取りに行く)。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { type Format } from "@dm-ai/core";
import { sleep } from "../lib.js";

type Sql = ReturnType<typeof getSql>;

const SITE_BASE_URL = "https://supersolenoid.jp";
/** デュエル・マスターズ カテゴリ (DM情報)。ページ送りは blog-category-12-<n>.html */
const DM_CATEGORY_ID = 12;
/** 取込元に名乗る User-Agent (問い合わせ先を含める) */
const USER_AGENT =
  "DM-AI-bot/1.0 (+https://github.com/shiyow5/DuelMasters-AI; Duel Masters Q&A assistant)";
/** リクエスト間のウェイト (ms)。個人ブログなので控えめにする */
const REQUEST_INTERVAL_MS = 1000;
/** 既定で遡るカテゴリページ数。1ページあたり CS 記事 15〜23 本、20ページで概ね過去5〜6週 */
const DEFAULT_MAX_PAGES = 20;

/** 記事タイトルのフォーマット表記 → DB の format。2ブロックは非対応なので載せない。 */
const FORMAT_LABELS: Record<string, Format> = {
  オリジナル: "original",
  アドバンス: "advance",
};

export interface CsPlacement {
  deck_archetype: string;
  placement: number;
}

export interface CsResult {
  format: Format;
  event_name: string;
  event_date: string;
  results: CsPlacement[];
}

export interface WeeklyEntry {
  deck_archetype: string;
  entries: number;
}

export interface WeeklyRanking {
  format: Format;
  period_start: string;
  period_end: string;
  total_entries: number;
  entries: WeeklyEntry[];
}

export interface EntryLink {
  url: string;
  title: string;
}

/** "2026/7/6" → "2026-07-06" */
function isoDate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** 最小限の HTML エンティティ復元 (一覧のタイトルにしか使わない) */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * 順位ラベルを「最低でも何位か」に変換する。
 * - 優勝 → 1 / 準優勝 → 2 / N位入賞 → N
 * - ベストN は N/2+1 〜 N 位の範囲を指す (ベスト4 = 3〜4位、ベスト8 = 5〜8位)
 */
function basePlacement(label: string): number | null {
  if (label === "優勝") return 1;
  if (label === "準優勝") return 2;
  const rank = label.match(/^(\d+)位入賞$/);
  if (rank) return parseInt(rank[1], 10);
  const best = label.match(/^ベスト(\d+)$/);
  if (best) return Math.floor(parseInt(best[1], 10) / 2) + 1;
  return null;
}

const CS_TITLE_PATTERN =
  /^【デュエマ\s*(.+?)CS】\s*「(.+)\((\d{4})\/(\d{1,2})\/(\d{1,2})\)」\s*結果\s*(.*)$/;
/**
 * 「<デッキ名>が<順位>」。1つのデッキが複数入賞したときは順位が「・」で連なる
 * (例: 「ミラダンテ槍＆ロマネスク入り白緑ウィリデが準優勝・3位入賞」)。
 * デッキ名自体にも「・」が入りうる (「ボルメテウス・ソル」) ので、
 * 順位ラベルの連なりを末尾に固定し、名前は貪欲に取る。
 */
const PLACEMENT_LABEL = "(?:優勝|準優勝|\\d+位入賞|ベスト\\d+)";
const PLACEMENT_PATTERN = new RegExp(`^(.+)が(${PLACEMENT_LABEL}(?:・${PLACEMENT_LABEL})*)$`);

/**
 * 個別 CS 記事のタイトルを構造化する。対応フォーマット外 (2ブロック等) や
 * CS 結果でないタイトルは null。
 *
 * 例: 【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果　白緑ウィリデが優勝　…
 */
export function parseCsResultTitle(title: string): CsResult | null {
  const m = title.trim().match(CS_TITLE_PATTERN);
  if (!m) return null;

  const format = FORMAT_LABELS[m[1].trim()];
  if (!format) return null; // 2ブロック等

  // 大会名は貪欲マッチで「末尾の (日付) の手前まで」を取るので、名前に括弧があっても壊れない
  const eventName = m[2].trim();
  const eventDate = isoDate(m[3], m[4], m[5]);

  const results: CsPlacement[] = [];
  const used = new Set<number>();

  for (const token of m[6].split(/[\s　]+/)) {
    const p = token.match(PLACEMENT_PATTERN);
    if (!p) continue;
    const archetype = p[1].trim();

    for (const label of p[2].split("・")) {
      const base = basePlacement(label);
      if (base === null) continue;

      // 同順位が並ぶ (3位入賞 ×2、ベスト4 ×2 など)。ユニーク制約
      // (event_name, event_date, format, deck_archetype, placement) で潰れて入賞数を
      // 取りこぼさないよう、空いている順位を順に割り当てる。
      let placement = base;
      while (used.has(placement)) placement++;
      used.add(placement);

      results.push({ deck_archetype: archetype, placement });
    }
  }

  if (results.length === 0) return null;
  return { format, event_name: eventName, event_date: eventDate, results };
}

/**
 * 週次ランキング記事のタイトルには2つの形がある。
 *
 * - 記事本来のタイトル (カテゴリ一覧の記事リンク):
 *     「【デュエマ オリジナルCS】「入賞数ランキング(7/6～7/12)」 逆札篇第2弾環境…」
 * - サイドバー「人気の記事」の短いタイトル:
 *     「オリジナルCS入賞数ランキング(7/6～7/12)」
 *
 * 短い形だけを見ていると、記事が「人気の記事」から外れた瞬間に取り逃す
 * (過去週の埋め戻しが効かなくなる)。両方を受ける。
 */
const RANKING_TITLE_PATTERNS = [
  /^【デュエマ\s*(.+?)CS】\s*「入賞数ランキング/,
  /^(オリジナル|アドバンス|2ブロック)CS入賞数ランキング/,
];

/** タイトルからフォーマットを取り出す。対応フォーマット外 (2ブロック) や非ランキングは null。 */
export function weeklyRankingFormat(title: string): Format | null {
  const t = title.trim();
  for (const pattern of RANKING_TITLE_PATTERNS) {
    const m = t.match(pattern);
    if (m) return FORMAT_LABELS[m[1].trim()] ?? null;
  }
  return null;
}

/** 週次ランキング記事のタイトルか (対応フォーマットのものだけ true) */
export function isWeeklyRankingTitle(title: string): boolean {
  return weeklyRankingFormat(title) !== null;
}

/**
 * 巡回するカテゴリページの URL。
 *
 * FC2 の「現在のページ」は**サフィックス無し** (`blog-category-12.html`)。
 * `-1` から始めると最新の記事を毎回取り逃す
 * (実測: サフィックス無しにしか無い CS 記事が4本あった)。先頭に必ず含める。
 */
export function categoryPageUrls(maxPages: number): string[] {
  const base = `${SITE_BASE_URL}/blog-category-${DM_CATEGORY_ID}`;
  return [`${base}.html`, ...Array.from({ length: maxPages }, (_, i) => `${base}-${i + 1}.html`)];
}

const PERIOD_PATTERN =
  /集計期間[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[～~〜]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/;
const TOTAL_PATTERN = /母数[：:]\s*(\d+)/;
const RANK_HEADING_PATTERN = /^入賞数\d+位\s*[（(]\s*(\d+)件/;
const SINGLETON_HEADING_PATTERN = /^母数1のデッキ/;
const ARCHETYPE_LINE_PATTERN = /^[・･]\s*(.+)$/;

/**
 * 週次ランキング記事の本文から、アーキタイプ別の入賞数を取り出す。
 *
 * 本文の形:
 *   集計期間：2026/7/6～2026/7/12
 *   母数：274
 *   入賞数1位 (50件、18.2％)
 *   ・ウィリデ(白緑42、白青6、赤白2)      ← 色の内訳カッコは落として「ウィリデ」にする
 *   入賞数11位 (8件、2.9％)
 *   ・墓地ソースゾロアスタート(全て黒緑t赤)  ← 同着は並ぶ。どちらも 8件
 *   ・ゴルギーオージャー(全てトリーヴァ)
 *   母数1のデッキ (4.7％)
 *   ・ガイアハザード退化                    ← この節は1件ずつ
 */
export function parseWeeklyRanking(body: string, format: Format): WeeklyRanking | null {
  const period = body.match(PERIOD_PATTERN);
  const total = body.match(TOTAL_PATTERN);
  if (!period || !total) return null;

  const entries: WeeklyEntry[] = [];
  let currentCount: number | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    const rank = line.match(RANK_HEADING_PATTERN);
    if (rank) {
      currentCount = parseInt(rank[1], 10);
      continue;
    }
    if (SINGLETON_HEADING_PATTERN.test(line)) {
      currentCount = 1; // 「母数1のデッキ」節はすべて 1件
      continue;
    }

    const item = line.match(ARCHETYPE_LINE_PATTERN);

    // データ節はここで終わり。記事の下にはコメント欄の注意書きが「・」付きで並んでいるので、
    // 見出しでも項目でもない行 (地の文) が出たら、そこから先は読まない。
    // HTML のコンテナ名に頼るより、ブログのテンプレ変更に強い。
    if (!item) {
      if (currentCount !== null) break;
      continue;
    }
    if (currentCount === null) continue;

    // 「ウィリデ(白緑42、白青6、赤白2)」→「ウィリデ」。色や型の内訳は捨てる。
    // 個別 CS 記事は「白緑ウィリデ」のような色つきの名前を使うが、ティアの単位は
    // ブログが束ねているアーキタイプ (ウィリデ) のほうなので、そちらに揃える。
    const name = item[1].replace(/[（(][^）)]*[）)]\s*$/, "").trim();
    if (name === "") continue;
    entries.push({ deck_archetype: name, entries: currentCount });
  }

  if (entries.length === 0) return null;

  return {
    format,
    period_start: isoDate(period[1], period[2], period[3]),
    period_end: isoDate(period[4], period[5], period[6]),
    total_entries: parseInt(total[1], 10),
    entries,
  };
}

const ENTRY_LINK_PATTERN = new RegExp(
  `<a[^>]+href="(https?://supersolenoid\\.jp/blog-entry-\\d+\\.html)"[^>]*>([\\s\\S]*?)</a>`,
  "g",
);

/**
 * カテゴリ一覧 HTML から記事 URL とタイトルを取り出す。
 * 同じ記事へのリンクが複数あれば、テキストを持つ最初のものを採る (サムネイルのリンクは空)。
 */
export function parseEntryList(html: string): EntryLink[] {
  const byUrl = new Map<string, string>();

  for (const m of html.matchAll(ENTRY_LINK_PATTERN)) {
    const url = m[1];
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (title === "") continue;
    if (!byUrl.has(url)) byUrl.set(url, title);
  }

  return [...byUrl.entries()].map(([url, title]) => ({ url, title }));
}

/**
 * 記事ページをテキスト化する (週次ランキング記事のパース用)。
 *
 * 本文コンテナ (FC2 の div.EntryBody / div.EntryMore) を切り出そうとすると、テンプレートを
 * 変えられた瞬間に壊れる。ここではページ全体を素直にテキスト化し、どこまでがデータかは
 * parseWeeklyRanking 側が構造で判断する (地の文が出たら打ち切る)。
 */
export function extractEntryBody(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "\n");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export interface IngestTournamentsOptions {
  /** 遡るカテゴリページ数 */
  maxPages?: number;
}

export interface IngestTournamentsResult {
  events: number;
  placements: number;
  weeks: number;
  weeklyEntries: number;
}

export async function runIngestTournaments(
  options: IngestTournamentsOptions = {},
): Promise<IngestTournamentsResult> {
  const { maxPages = DEFAULT_MAX_PAGES } = options;
  const sql = getSql();

  // 既に「完全に」取り込んだ週は本文を取りに行かない。
  // 1行でもあれば取込済みとみなすと、途中で落ちた週が永久に部分データのまま残り、
  // その週のティア割合が狂う。母数と入賞数の合計が一致する週だけを完了扱いにする。
  const ingestedWeeks = new Set<string>(
    (
      await sql`
        SELECT format, period_start
        FROM archetype_weekly_stats
        GROUP BY format, period_start, period_end, total_entries
        HAVING SUM(entries) = total_entries
      `
    ).map((r) => `${r.format}|${(r.period_start as Date).toISOString().split("T")[0]}`),
  );

  const csResults: Array<{ cs: CsResult; url: string }> = [];
  const rankingLinks: Array<{ url: string; format: Format }> = [];
  const seenEntry = new Set<string>();

  for (const url of categoryPageUrls(maxPages)) {
    let html: string;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.error(`[tournaments] 一覧ページの取得に失敗 (以降を打ち切ります): ${url}`, err);
      break;
    }

    for (const entry of parseEntryList(html)) {
      // サフィックス無しのページと -1 以降は内容が重なるうえ、サイドバー (人気の記事) は
      // どのページにも出る。記事 URL で重複を除く。
      if (seenEntry.has(entry.url)) continue;

      const cs = parseCsResultTitle(entry.title);
      if (cs) {
        seenEntry.add(entry.url);
        csResults.push({ cs, url: entry.url });
        continue;
      }

      const format = weeklyRankingFormat(entry.title);
      if (format) {
        seenEntry.add(entry.url);
        rankingLinks.push({ url: entry.url, format });
      }
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  // --- 週次ランキング → archetype_weekly_stats (ティア表の一次ソース) ---
  let weeks = 0;
  let weeklyEntries = 0;
  const seenRanking = new Set<string>();

  for (const link of rankingLinks) {
    if (seenRanking.has(link.url)) continue;
    seenRanking.add(link.url);

    let ranking: WeeklyRanking | null;
    try {
      ranking = parseWeeklyRanking(extractEntryBody(await fetchPage(link.url)), link.format);
    } catch (err) {
      console.error(`[tournaments] ランキング記事の取得に失敗: ${link.url}`, err);
      continue;
    }
    await sleep(REQUEST_INTERVAL_MS);

    if (!ranking) {
      console.warn(`[tournaments] ランキング記事をパースできません: ${link.url}`);
      continue;
    }
    if (ingestedWeeks.has(`${ranking.format}|${ranking.period_start}`)) continue;

    // 自己検証: 入賞数の合計は母数に一致するはず。ずれたら記事の書式が変わった疑いがある。
    const sum = ranking.entries.reduce((acc, e) => acc + e.entries, 0);
    if (sum !== ranking.total_entries) {
      console.warn(
        `[tournaments] 入賞数の合計 ${sum} が母数 ${ranking.total_entries} と一致しません ` +
          `(${link.url})。書式が変わった可能性があるためこの週は取り込みません。`,
      );
      continue;
    }

    // 週の行はトランザクションでまとめて入れる。途中で落ちて一部だけ残ると、
    // 次回以降その週は「取込済み」と誤認されかねず、ティア割合が狂ったまま固定される。
    const week = ranking;
    await sql.begin(async (tx) => {
      // postgres.js の TransactionSql はタグ付きテンプレートとして呼べる型になっていない
      // (packages/rag/src/search.ts の withIterativeScan と同じ回避)
      const txSql = tx as unknown as Sql;
      for (const e of week.entries) {
        await txSql`
          INSERT INTO archetype_weekly_stats
            (format, period_start, period_end, deck_archetype, entries, total_entries, source_url)
          VALUES (${week.format}, ${week.period_start}, ${week.period_end},
                  ${e.deck_archetype}, ${e.entries}, ${week.total_entries}, ${link.url})
          ON CONFLICT (format, period_start, period_end, deck_archetype)
          DO UPDATE SET entries = EXCLUDED.entries, total_entries = EXCLUDED.total_entries
        `;
      }
    });
    weeklyEntries += week.entries.length;
    weeks++;
    console.log(
      `[tournaments] 週次ランキング ${ranking.format} ${ranking.period_start}〜${ranking.period_end}: ` +
        `${ranking.entries.length}アーキタイプ / 母数 ${ranking.total_entries}`,
    );
  }

  // --- 個別 CS 記事 → tournament_results (入賞履歴。ティアの母集団には使わない) ---
  let events = 0;
  let placements = 0;

  for (const { cs, url } of csResults) {
    let insertedHere = 0;
    for (const r of cs.results) {
      // source_url は記事の URL を入れる。サイトのトップを入れると
      // /api/meta/archetype/:name の recent_results から元記事に辿れなくなる。
      const res = await sql`
        INSERT INTO tournament_results
          (event_name, event_date, format, deck_archetype, placement, source_url)
        VALUES (${cs.event_name}, ${cs.event_date}, ${cs.format},
                ${r.deck_archetype}, ${r.placement}, ${url})
        ON CONFLICT (event_name, event_date, format, deck_archetype, placement) DO NOTHING
      `;
      if (res.count > 0) insertedHere++;
    }
    if (insertedHere > 0) events++;
    placements += insertedHere;
  }

  console.log(
    `=== 大会結果取り込み完了: 週次ランキング ${weeks}週 (${weeklyEntries}行) / ` +
      `個別CS ${events}大会 (${placements}入賞) ===`,
  );

  await closeDb();
  return { events, placements, weeks, weeklyEntries };
}

/** CLI 引数を検証する */
export function parseTournamentsArgs(argv: string[]): IngestTournamentsOptions {
  const pages = argv.find((a) => a.startsWith("--pages="));
  const maxPages = pages ? parseInt(pages.split("=")[1], 10) : undefined;
  return maxPages && maxPages > 0 ? { maxPages } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestTournaments(parseTournamentsArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
