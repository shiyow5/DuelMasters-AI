/**
 * リンクの URL を許可制で通す (#100)。
 *
 * エージェントの回答は **LLM 由来 = 実質的に信頼できない入力**で、RAG 経由で外部サイトの
 * テキストも混ざる。Markdown のリンク記法 `[text](javascript:...)` は、そのまま `<a href>` に
 * なると**クリックでスクリプトが走る**。scheme を許可制にして塞ぐ。
 *
 * ブロックした場合は空文字を返す (react-markdown の urlTransform は空文字で href を落とす)。
 */

/** 許可する scheme。これ以外の scheme 付き URL は落とす。 */
const ALLOWED_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

/**
 * scheme の判定前に消す文字。
 *
 * ブラウザは `java\tscript:` や `java\nscript:` を `javascript:` として解釈することがある。
 * タブ・改行・NUL などの制御文字を挟んで検査をすり抜ける古典的な手口なので、
 * **判定用の文字列からは制御文字を全部落としてから** scheme を見る。
 */
const CONTROL_AND_SPACE = /[\u0000-\u0020\u007f]/g;

export function safeUrl(url: string): string {
  if (!url) return "";

  const probe = url.replace(CONTROL_AND_SPACE, "").toLowerCase();

  // scheme 付きでなければ相対リンク (/rule, #section, ./a)。そのまま通す。
  const colon = probe.indexOf(":");
  if (colon === -1) return url;

  // "#a:b" のように、scheme より前に # や / や ? があるものは相対リンク扱い。
  const beforeColon = probe.slice(0, colon);
  if (/[#/?]/.test(beforeColon)) return url;

  return ALLOWED_SCHEMES.includes(`${beforeColon}:`) ? url : "";
}
