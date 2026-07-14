/**
 * エージェントの進行表示 (#98)。
 *
 * 回答が出るまで十数秒かかる。三点リーダーだけでは何も起きていないように見えるので、
 * 「いま何をしているか」を出す。生のツール名 (`search_rules`) では分からないし、
 * ツール名だけでは **何を** 調べているのかが分からない。引数まで出す。
 */

/** ツール名 → 進行表示の文言。対応表に無いツールは名前をそのまま出す (黙って壊れない)。 */
export const TOOL_LABELS: Record<string, string> = {
  search_rules: "ルールを検索しています",
  search_cards: "カードを検索しています",
  evaluate_deck: "デッキを評価しています",
  build_deck: "デッキを構築しています",
  get_tier_list: "環境データを確認しています",
  suggest_improvements: "改善案を考えています",
};

/**
 * ツールごとの「見出しになる引数」。
 *
 * `evaluate_deck` / `suggest_improvements` の `decklist` は**40行のテキスト**なので載せない。
 * 進行表示に流し込むと画面が壊れる。
 */
const SUBJECT_KEY: Record<string, string> = {
  search_rules: "query",
  search_cards: "query",
  build_deck: "theme",
  get_tier_list: "format",
};

const FORMAT_LABELS: Record<string, string> = {
  original: "オリジナル",
  advance: "アドバンス",
};

/** 進行表示は1行に収める。長いクエリはここで切る。 */
const MAX_SUBJECT_LENGTH = 40;

/**
 * 文字数で切り詰める (サロゲートペアを割らない)。
 *
 * `String.prototype.slice` は UTF-16 コードユニット単位なので、絵文字や CJK 拡張面の文字を
 * 途中で割って壊れた文字を出しうる。コードポイント単位で切る。
 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** そのツール呼び出しが「何について」なのかを1行で返す。出すものが無ければ null。 */
export function toolSubject(name: string, args: Record<string, unknown>): string | null {
  const key = SUBJECT_KEY[name];
  if (!key) return null;

  const raw = args?.[key];
  if (typeof raw !== "string") return null;

  // 改行を空白に潰す。進行表示が複数行になるとレイアウトが崩れる。
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;

  // フォーマットの日本語化は **format 引数のときだけ**。全ツールに当てると、
  // 「アドバンスのルールを知りたい」という検索クエリ (query が "advance" 一語) まで
  // 「アドバンス」に化けて、実際に投げたクエリと表示が食い違う。
  const labelled = key === "format" ? (FORMAT_LABELS[text] ?? text) : text;
  return truncate(labelled, MAX_SUBJECT_LENGTH);
}

/** 「ルールを検索しています: 「S・トリガー」」のような1行を作る。 */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
  const base = TOOL_LABELS[name] ?? name;
  const subject = toolSubject(name, args);
  return subject ? `${base}: 「${subject}」` : base;
}

/**
 * 失敗表示用の名詞ラベル。
 *
 * TOOL_LABELS は進行表示用の**文**なので (「カードを検索しています」)、
 * 「〜に失敗しました」に繋ぐと日本語が壊れる。名詞を別に持つ。
 *
 * **bot 側 (`apps/bot/src/interactions/run.ts`) にも同じ表がある。** web は意図的に
 * workspace パッケージへ依存しておらず (types.ts は「api の応答形状の写し」)、共有すると
 * その設計判断を覆すことになるので複製している。知らないツール名は生の名前にフォールバック
 * するだけなので、片方を更新し忘れても壊れない (表示が英語になるだけ)。
 */
const TOOL_NOUNS: Record<string, string> = {
  search_rules: "ルール検索",
  search_cards: "カード検索",
  evaluate_deck: "デッキ評価",
  build_deck: "デッキ構築",
  get_tier_list: "環境データの取得",
  suggest_improvements: "改善案の作成",
};

/**
 * ツール失敗の文言 (#109)。
 *
 * **「エラーが発生しました」で終わらせない。** 何が取れなかったのかと、その結果この回答が
 * どういう性質のものになるのかを伝える。握り潰すと利用者には普通の回答に見え、モデルが
 * 記憶で埋めた内容を信じてしまう (#112 で実際に起きた)。
 */
export function toolErrorLabel(names: string[]): string {
  const unique = [...new Set(names)].map((n) => TOOL_NOUNS[n] ?? n);
  return `${unique.join(" / ")}に失敗しました。この回答はデータで裏付けられていません。`;
}

/**
 * グラフのノードを通過した「あと」に phase が流れる。つまり phase は「いま何が終わったか」。
 * 画面に出すのは「次に何をしているか」なので、そのようにマップする。
 *
 * `agent` と `finalize` では文言を変えない。直後にトークンが流れ始めるので、ここで
 * 文言を出すと回答が表示される瞬間に進行表示が上書きされてちらつく。
 */
export function phaseLabel(node: string): string | null {
  switch (node) {
    case "retrieve":
      return "回答を考えています";
    case "tools":
      return "検索結果を読んでいます";
    default:
      return null;
  }
}

/**
 * 最初のイベントが届くまでに出しておく文言。
 *
 * 実測 (#91) で最初の `tool` イベントまで 790ms、rule モードは RAG の retrieve が先に走るので
 * さらに長い。その間ずっと三点リーダーだと、固まったように見える。
 *
 * グラフは rule のとき retrieve から始まる (`state.mode === "rule" ? "retrieve" : "agent"`)
 * ので、rule だけは「条文を探している」と言い切れる。
 */
export function initialStatus(mode: string): string {
  return mode === "rule" ? "関連する条文を探しています" : "質問を読み取っています";
}
