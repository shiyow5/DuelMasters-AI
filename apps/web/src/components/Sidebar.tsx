"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthPanel from "./AuthPanel";
import ChatHistory from "./ChatHistory";
import { useSidebar } from "./SidebarContext";

const NAV_ITEMS = [
  { href: "/", icon: "chat_bubble", label: "AIチャット" },
  { href: "/rule", icon: "gavel", label: "ルール検索" },
  { href: "/deck", icon: "style", label: "デッキビルダー" },
  { href: "/meta", icon: "monitoring", label: "環境分析" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { open, closeSidebar } = useSidebar();

  // ページレイアウトは lg で desktop 構成に切り替わるため、常設サイドバーも lg 以上。
  // lg 未満 (モバイル/タブレット) はオフキャンバス。
  const [offCanvas, setOffCanvas] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setOffCanvas(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // オフキャンバスで閉じている間は、画面外の nav をタブ順・支援技術から除外する。
  const hiddenOffCanvas = offCanvas && !open;

  return (
    <>
      {/* モバイル/タブレット: オフキャンバス表示中の背景オーバーレイ */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <nav
        inert={hiddenOffCanvas || undefined}
        aria-hidden={hiddenOffCanvas || undefined}
        className={`fixed inset-y-0 left-0 z-50 w-64 flex-shrink-0 flex flex-col justify-between bg-bg-surface border-r border-border-subtle h-full transform transition-transform duration-300 ease-in-out lg:static lg:z-auto lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-col gap-6 p-6 min-h-0 flex-1 overflow-y-auto">
          {/* Logo + モバイル用クローズボタン */}
          <div className="flex items-start justify-between">
            <Link href="/" className="flex flex-col" onClick={closeSidebar}>
              <h1 className="text-white text-xl font-bold tracking-tight">DM AI Master</h1>
              <p className="text-text-muted text-xs mt-1">デュエル・マスターズ戦略ツール</p>
            </Link>
            <button
              onClick={closeSidebar}
              className="lg:hidden -mr-2 p-1 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors"
              aria-label="メニューを閉じる"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          {/* Nav Links */}
          <div className="flex flex-col gap-2">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={closeSidebar}
                  className={
                    isActive
                      ? "flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/10 text-primary border border-primary/20"
                      : "flex items-center gap-3 px-4 py-3 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors group"
                  }
                >
                  <span
                    className={`material-symbols-outlined ${
                      isActive ? "text-primary" : "group-hover:text-primary transition-colors"
                    }`}
                  >
                    {item.icon}
                  </span>
                  <span className="text-sm font-medium">{item.label}</span>
                </Link>
              );
            })}
          </div>

          {/* 会話履歴 (#110)。チャットページでのみ意味があるので、そこにいる時だけ出す。 */}
          {pathname === "/" && (
            <div className="flex flex-col gap-2">
              <h2 className="px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted">
                会話履歴
              </h2>
              <Suspense fallback={<p className="px-3 text-xs text-text-muted">読み込み中…</p>}>
                <ChatHistory onNavigate={closeSidebar} />
              </Suspense>
            </div>
          )}
        </div>

        {/* Bottom: 認証パネル (NEXT_PUBLIC_SUPABASE_* 未設定なら非表示) */}
        <div className="p-4 border-t border-border-subtle">
          <AuthPanel />
        </div>
      </nav>
    </>
  );
}
