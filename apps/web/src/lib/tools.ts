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

/** そのツール呼び出しが「何について」なのかを1行で返す。出すものが無ければ null。 */
export function toolSubject(name: string, args: Record<string, unknown>): string | null {
  const key = SUBJECT_KEY[name];
  if (!key) return null;

  const raw = args?.[key];
  if (typeof raw !== "string") return null;

  // 改行を空白に潰す。進行表示が複数行になるとレイアウトが崩れる。
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;

  const labelled = FORMAT_LABELS[text] ?? text;
  return labelled.length > MAX_SUBJECT_LENGTH
    ? `${labelled.slice(0, MAX_SUBJECT_LENGTH)}…`
    : labelled;
}

/** 「ルールを検索しています: 「S・トリガー」」のような1行を作る。 */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
  const base = TOOL_LABELS[name] ?? name;
  const subject = toolSubject(name, args);
  return subject ? `${base}: 「${subject}」` : base;
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
