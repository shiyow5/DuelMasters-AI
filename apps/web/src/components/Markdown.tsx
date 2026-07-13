"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { safeUrl } from "@/lib/safe-url";

/**
 * エージェントの回答を Markdown として描画する (#100)。
 *
 * LLM は箇条書き・見出し・強調・表を Markdown で書いてくる。プレーンテキストで出していたため、
 * `**S・トリガー**` や `- 項目` が記号のまま画面に出ていた。ルール回答は
 * 「結論 → 根拠 → 例外」の構造を持つ (rule モードの prompt がそう指示している) ので、
 * 構造が潰れると読みづらさが直撃する。
 *
 * ## セキュリティ (ここを崩すと即 XSS)
 *
 * 回答は **LLM 由来 = 実質的に信頼できない入力**で、RAG 経由で外部サイトのテキストも混ざる。
 *
 * - **`rehype-raw` を入れない。** 入れると回答中の `<img onerror=...>` がそのまま DOM になる。
 *   react-markdown は既定で生 HTML を描画しない (テキストとして扱う)。この既定に頼る。
 * - **`dangerouslySetInnerHTML` を使わない。**
 * - リンクの scheme は許可制 (`safeUrl`)。`[click](javascript:alert(1))` を塞ぐ。
 * - 外部リンクは `rel="noopener noreferrer"` + `target="_blank"`。
 *
 * ## ストリーミング中でも壊れないこと
 *
 * `token` は1文字ずつ届くので、`**` が片方しか来ていない / コードフェンスが閉じていない、
 * という状態が必ず発生する。react-markdown は未閉じでも例外を投げない (テストで固定)。
 */

/** 見出しは吹き出しの中なので、ページ見出しより一段小さくする。 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-bold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-3 text-base font-bold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-bold first:mt-0">{children}</h4>,
  strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-primary/40 pl-3 text-text-sub last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    // インラインコードとコードブロックを className の有無で見分ける (react-markdown の慣例)。
    const isBlock = Boolean(className);
    return isBlock ? (
      <code className="block overflow-x-auto rounded-lg bg-black/40 p-3 text-xs">{children}</code>
    ) : (
      <code className="rounded bg-white/10 px-1 py-0.5 text-[0.9em]">{children}</code>
    );
  },
  pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
  // 表は横に溢れる。**表だけ**を横スクロールさせ、ページ本体を横スクロールさせない。
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-subtle px-2 py-1 text-left font-bold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border-subtle px-2 py-1">{children}</td>,
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown
        // remarkBreaks: LLM は段落を空行で区切らず単一改行で書くことがある。
        // Markdown の既定では単一改行が無視され、回答が1行に潰れて読めなくなる。
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // rehypePlugins は**空のまま**にする。rehype-raw を足すと生 HTML が通り、XSS になる。
        components={COMPONENTS}
        urlTransform={safeUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
