/**
 * CS 入賞デッキレシピ取り込みジョブ。取込元は「デネブログ」(deneblog.jp) カテゴリ72。
 *
 * **ティア表とは連携しない。** 理由は infra/sql/009_deck_recipes.sql に詳しく書いた。
 * 要点だけ再掲すると、着手前の実測で:
 *   - アーキタイプ名の一致率 35/79 = 44.3% (完全一致 19.0%)、大会名での突き合わせは 6.3%
 *   - **デネブログはフォーマット (オリジナル/アドバンス) をどこにも書いていない**
 * ため、レシピを「どのティア行に出すか」が原理的に決まらない。推測して載せると、
 * そのフォーマットで使えないカードを含むリストを見せることになる。
 *
 * したがってここでは**デネブログが書いていることだけ**を取り込む
 * (大会名・順位・デッキ名・プレイヤー・参加人数・レシピ画像・掲載日)。
 * フォーマットや正規化アーキタイプは**でっち上げない**。
 *
 * 取込マナー: robots.txt は取込を許可 (Disallow は /tb.php/ のみ)。週1の cron、
 * リクエスト間に 1 秒のウェイト、識別可能な User-Agent。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { sleep } from "../lib.js";

const SITE_BASE_URL = "https://deneblog.jp";
/** CS優勝・入賞デッキレシピ カテゴリ。ページ送りは blog-category-72-<n>.html */
const RECIPE_CATEGORY_ID = 72;
const USER_AGENT =
  "DM-AI-bot/1.0 (+https://github.com/shiyow5/DuelMasters-AI; Duel Masters Q&A assistant)";
const REQUEST_INTERVAL_MS = 1000;
/** 既定で遡るカテゴリページ数。1ページあたり記事 20本前後 */
const DEFAULT_MAX_PAGES = 5;

export interface RecipeTitle {
  event_name: string;
  placement_label: string;
  deck_name: string;
  player: string | null;
}

export interface RecipeBody {
  /** 記事の掲載日。**大会の開催日ではない** (デネブログは開催日を書いていない) */
  posted_date: string;
  decklist_image_url: string;
  participants: number | null;
}

export interface RecipeEntryLink {
  url: string;
  title: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const RECIPE_TITLE_PATTERN = /^【\s*#デュエマCS入賞デッキレシピ\s*】(.+)$/;
/**
 * 順位ラベル (末尾に固定)。全角数字もそのまま受ける。
 *
 * 「準優勝」を先に置いているのは読みやすさのためで、**動作は並び順に依存しない**。
 * `$` 固定なので、正規表現は「末尾まで一致する最も左の位置」を採る。「…CS準優勝」なら
 * 「準」の位置でしか末尾まで届かず、そこで一致するのは `準優勝` だけなので、
 * `優勝` を先に書いても結果は変わらない (node で実測確認済み)。
 *
 * 一方 `[0-9０-９]+位(?:入賞)?` の `(?:入賞)?` は**同じ選択肢の中に**入れる必要がある。
 * `位` と `位入賞` を別の選択肢に割ると、先に書いたほうだけが採られて
 * 「5位入賞」の「入賞」が大会名側に残る。
 */
const PLACEMENT_PATTERN = /(準優勝|優勝|[0-9０-９]+位(?:入賞)?|ベスト\s*[0-9０-９]+)$/;

/**
 * 記事タイトルを構造化する。
 *
 * 例: 【 #デュエマCS入賞デッキレシピ 】トレカラインCS優勝　サガループ　🍣mofura🍣さん
 *     → 大会名「トレカラインCS」/ 順位「優勝」/ デッキ名「サガループ」/ プレイヤー「🍣mofura🍣」
 *
 * **フィールドの区切りは全角スペース。** 半角スペースで割ると、空白入りのプレイヤー名
 * (「DOplayer とらっちさん」) でデッキ名を取り違える (実測で踏んだ)。
 */
export function parseRecipeTitle(title: string): RecipeTitle | null {
  const m = title.trim().match(RECIPE_TITLE_PATTERN);
  if (!m) return null;

  const parts = m[1].split("　").filter((p) => p.trim() !== "");
  // <大会名+順位>　<デッキ名>　<プレイヤー>さん の3フィールドが要る
  if (parts.length < 3) return null;

  const last = parts[parts.length - 1].trim();
  if (!last.endsWith("さん")) return null;

  const deckName = parts[parts.length - 2].trim();
  // 大会名に全角スペースが入る場合に備えて、残り全部を繋ぎ直す
  const head = parts
    .slice(0, parts.length - 2)
    .join("　")
    .trim();

  const p = head.match(PLACEMENT_PATTERN);
  // 順位が読めないものは**推測せずに捨てる**
  if (!p) return null;

  const eventName = head.slice(0, head.length - p[0].length).trim();
  if (eventName === "" || deckName === "") return null;

  const player = last.slice(0, -"さん".length).trim();
  return {
    event_name: eventName,
    placement_label: p[0].trim(),
    deck_name: deckName,
    player: player === "" ? null : player,
  };
}

/** 記事の掲載日「2026.07.13 16:21」 */
const POSTED_DATE_PATTERN = /(20\d{2})\.(\d{2})\.(\d{2})\s+\d{1,2}:\d{2}/;
const IMAGE_LINK_PATTERN = /<a[^>]+href="(https:\/\/blog-imgs-[^"]+\.(?:jpg|jpeg|png))"/i;
const PARTICIPANTS_PATTERN = /参加人数\s*([0-9０-９]+)\s*人/;
/**
 * デッキリスト画像を特定する構造アンカー。
 *
 * 本文はどの記事も
 *   [アイキャッチ画像] → 募集の定型文 → 見出し → **[デッキリスト画像]**
 * の順に並ぶので、**定型文より後ろの最初の画像**がデッキリストになる。
 *
 * **アンカーは「応募方法はこちら」にする。** 定型文は時期で変わっており、
 * 「※もし1ヶ月以上掲載が行われていない場合は、…よりお問い合わせ下さい。」は
 * **新しい記事にしか無い**。そちらをアンカーにしていたため、本番の初回取込で
 * 古い記事 41/117 件をまるごと取りこぼした (実測)。
 * 「応募方法はこちら」は新旧どちらの記事にもあり、位置も同じ
 * (新旧18件で実測: 新記事7件は旧アンカーと同じ画像を指し、旧記事11件は
 *  このアンカーでのみ画像が取れる)。
 *
 * 「ファイル名の日付 == 掲載日」で選ぶ規則も試したが、アイキャッチが記事と同日に
 * アップされた記事で誤爆した (実測 20件中2件)。構造で選ぶのが正しい。
 */
const BODY_ANCHOR = "応募方法はこちら";

/**
 * 記事 HTML から掲載日・デッキリスト画像・参加人数を取り出す。
 *
 * デッキリスト画像が見つからない記事は null を返す (**バナーで代用しない**)。
 */
export function parseRecipeBody(html: string): RecipeBody | null {
  // テーマ側の綴りは entry ではなく ently。クラスが増えても拾えるようにする
  // (`class="ently_body clearfix"` のような複数クラス指定を素の文字列一致で見ると
  //  記事ごと取りこぼす)。
  const entryMatch = html.match(/class="[^"]*\bently_body\b[^"]*"/);
  // index === 0 は falsy なので、存在チェックは undefined 比較で行う
  if (entryMatch?.index === undefined) return null;
  const entry = html.slice(entryMatch.index);

  // 本文は ently_text から関連記事 (fc2relate) の手前まで。
  const textStart = entry.indexOf("ently_text");
  if (textStart < 0) return null;
  const relateStart = entry.indexOf("fc2relate", textStart);
  // **fc2relate が無いときに「ページ末尾まで」で代用しない。** 関連記事ウィジェットも
  // blog-imgs のサムネイルを張るので、範囲を絞れないまま画像を探すと、無関係な記事の
  // サムネイルをこの記事のデッキリストとして拾いうる。範囲を確定できないなら諦める
  // (誤ったレシピを見せるより、載せないほうがよい)。
  if (relateStart <= textStart) return null;
  const body = entry.slice(textStart, relateStart);

  // 掲載日は**本文より前**のヘッダ部にある。ページ全体を対象にすると、サイドバーの
  // 「最新記事」やコメント欄の日時を先に拾いうるので、ently_body〜本文の手前に絞る。
  const date = entry.slice(0, textStart).match(POSTED_DATE_PATTERN);
  if (!date) return null;

  const anchor = body.indexOf(BODY_ANCHOR);
  if (anchor < 0) return null;

  const image = body.slice(anchor).match(IMAGE_LINK_PATTERN);
  if (!image) return null;

  const people = body.match(PARTICIPANTS_PATTERN);

  return {
    posted_date: `${date[1]}-${date[2]}-${date[3]}`,
    decklist_image_url: image[1],
    // 全角数字を NFKC で半角に寄せてから数値化する
    participants: people ? parseInt(people[1].normalize("NFKC"), 10) : null,
  };
}

const ENTRY_LINK_PATTERN = new RegExp(
  `<a[^>]+href="(https?://deneblog\\.jp/blog-entry-\\d+\\.html)"[^>]*>([\\s\\S]*?)</a>`,
  "g",
);

/**
 * カテゴリ一覧 HTML から記事 URL とタイトルを取り出す。
 * 同じ記事へのリンクが複数あれば、テキストを持つ最初のものを採る (サムネイルのリンクは空)。
 */
export function parseRecipeEntryList(html: string): RecipeEntryLink[] {
  const byUrl = new Map<string, string>();
  for (const m of html.matchAll(ENTRY_LINK_PATTERN)) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (title === "") continue;
    if (!byUrl.has(m[1])) byUrl.set(m[1], title);
  }
  return [...byUrl.entries()].map(([url, title]) => ({ url, title }));
}

/**
 * 巡回するカテゴリページの URL。
 *
 * FC2 の「現在のページ」は**サフィックス無し**。`-1` から始めると最新記事を取り逃す
 * (ingest-tournaments で実証済み)。先頭に必ず含める。
 */
export function recipeCategoryPageUrls(maxPages: number): string[] {
  const base = `${SITE_BASE_URL}/blog-category-${RECIPE_CATEGORY_ID}`;
  return [`${base}.html`, ...Array.from({ length: maxPages }, (_, i) => `${base}-${i + 1}.html`)];
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export interface IngestDeneblogOptions {
  maxPages?: number;
}

export interface IngestDeneblogResult {
  recipes: number;
  skipped: number;
}

export async function runIngestDeneblog(
  options: IngestDeneblogOptions = {},
): Promise<IngestDeneblogResult> {
  const { maxPages = DEFAULT_MAX_PAGES } = options;
  const sql = getSql();

  // 取込済みの記事は本文を取りに行かない (記事は後から書き換わらない)
  const known = new Set<string>(
    (await sql`SELECT source_url FROM deck_recipes`).map((r) => r.source_url as string),
  );

  const targets: Array<{ url: string; title: RecipeTitle }> = [];
  const seen = new Set<string>();

  for (const url of recipeCategoryPageUrls(maxPages)) {
    let html: string;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.error(`[deneblog] 一覧ページの取得に失敗 (以降を打ち切ります): ${url}`, err);
      break;
    }

    for (const entry of parseRecipeEntryList(html)) {
      // サフィックス無しのページと -1 以降は内容が重なる。サイドバーも全ページに出る。
      if (seen.has(entry.url) || known.has(entry.url)) continue;
      const title = parseRecipeTitle(entry.title);
      if (!title) continue;
      seen.add(entry.url);
      targets.push({ url: entry.url, title });
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  let recipes = 0;
  let skipped = 0;

  for (const { url, title } of targets) {
    let body: RecipeBody | null;
    try {
      body = parseRecipeBody(await fetchPage(url));
    } catch (err) {
      console.error(`[deneblog] 記事の取得に失敗: ${url}`, err);
      skipped++;
      // 失敗時こそ待つ。ここで continue して即次を叩くと、相手が不調なときに
      // ウェイト無しで連打することになる。
      await sleep(REQUEST_INTERVAL_MS);
      continue;
    }
    await sleep(REQUEST_INTERVAL_MS);

    // デッキリスト画像が取れない記事は入れない。画像こそがこの機能の中身なので、
    // 画像なしの行を作っても一覧に穴が開くだけ。
    if (!body) {
      console.warn(`[deneblog] デッキリスト画像を特定できません (取り込みません): ${url}`);
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO deck_recipes
        (source_url, source, posted_date, event_name, placement_label,
         deck_name, player, participants, decklist_image_url)
      VALUES (${url}, 'deneblog', ${body.posted_date}, ${title.event_name},
              ${title.placement_label}, ${title.deck_name}, ${title.player},
              ${body.participants}, ${body.decklist_image_url})
      ON CONFLICT (source_url) DO UPDATE SET
        decklist_image_url = EXCLUDED.decklist_image_url,
        participants = EXCLUDED.participants
    `;
    recipes++;
  }

  console.log(`=== デッキレシピ取り込み完了: ${recipes}件 (スキップ ${skipped}件) ===`);

  await closeDb();
  return { recipes, skipped };
}

export function parseDeneblogArgs(argv: string[]): IngestDeneblogOptions {
  const pages = argv.find((a) => a.startsWith("--pages="));
  const maxPages = pages ? parseInt(pages.split("=")[1], 10) : undefined;
  return maxPages && maxPages > 0 ? { maxPages } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestDeneblog(parseDeneblogArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
