"use client";

import { useSidebar } from "./SidebarContext";

/**
 * 全ページ共通のヘッダーシェル。高さ・左右パディング・下ボーダー色・背景を統一する。
 * 左右のコンテンツは呼び出し側が `left` / `right` で渡す。
 * モバイルではサイドバーを開くハンバーガーを左端に表示する。
 *
 * sm (640px) 未満は 2 段にする: 1 段目 = ハンバーガー + 見出し (`w-full` で行を占有)、
 * 2 段目 = `right` (折り返して次の行へ)。狭い幅で `right` が縮まずに見出しを押し潰し、
 * 日本語の見出しが 1〜3 文字ずつ縦に折れていたため (UI改善 P-2)。
 * 見出しを 1 行に保つための `min-w-0` / `truncate` は呼び出し側の `left` で付ける。
 */
export default function Header({
  left,
  right,
}: {
  left: React.ReactNode;
  right?: React.ReactNode;
}) {
  const { openSidebar } = useSidebar();
  return (
    <header className="shrink-0 min-h-16 border-b border-border-subtle bg-bg-dark/80 backdrop-blur-md px-6 md:px-8 py-3 max-sm:py-2 flex items-center justify-between gap-4 max-sm:flex-wrap max-sm:gap-y-2">
      <div className="flex items-center gap-3 min-w-0 max-sm:w-full">
        <button
          onClick={openSidebar}
          className="lg:hidden -ml-1 p-2 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors"
          aria-label="メニューを開く"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>
        <div className="min-w-0 flex-1">{left}</div>
      </div>
      {right && (
        // 2 段目で幅が足りないときだけ横スクロール (保険)。px/py-0.5 はフォーカスリングの切れ防止。
        <div className="flex items-center gap-3 shrink-0 max-sm:w-full max-sm:shrink max-sm:overflow-x-auto max-sm:px-0.5 max-sm:py-0.5">
          {right}
        </div>
      )}
    </header>
  );
}
