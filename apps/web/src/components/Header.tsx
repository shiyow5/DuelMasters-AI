"use client";

import { useSidebar } from "./SidebarContext";

/**
 * 全ページ共通のヘッダーシェル。高さ・左右パディング・下ボーダー色・背景を統一する。
 * 左右のコンテンツは呼び出し側が `left` / `right` で渡す。
 * モバイルではサイドバーを開くハンバーガーを左端に表示する。
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
    <header className="shrink-0 min-h-16 border-b border-border-subtle bg-bg-dark/80 backdrop-blur-md px-6 md:px-8 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={openSidebar}
          className="md:hidden -ml-1 p-2 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors"
          aria-label="メニューを開く"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>
        <div className="min-w-0">{left}</div>
      </div>
      {right && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </header>
  );
}
