"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthPanel from "./AuthPanel";

const NAV_ITEMS = [
  { href: "/", icon: "chat_bubble", label: "AIチャット" },
  { href: "/rule", icon: "gavel", label: "ルール検索" },
  { href: "/deck", icon: "style", label: "デッキビルダー" },
  { href: "/meta", icon: "monitoring", label: "環境分析" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="w-64 flex-shrink-0 flex flex-col justify-between bg-bg-surface border-r border-border-subtle h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Logo */}
        <Link href="/" className="flex flex-col">
          <h1 className="text-white text-xl font-bold tracking-tight">
            DM AI Master
          </h1>
          <p className="text-text-muted text-xs mt-1">
            デュエル・マスターズ戦略ツール
          </p>
        </Link>

        {/* Nav Links */}
        <div className="flex flex-col gap-2">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  isActive
                    ? "flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/10 text-primary border border-primary/20"
                    : "flex items-center gap-3 px-4 py-3 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors group"
                }
              >
                <span
                  className={`material-symbols-outlined ${
                    isActive
                      ? "text-primary"
                      : "group-hover:text-primary transition-colors"
                  }`}
                >
                  {item.icon}
                </span>
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Bottom: 認証パネル (NEXT_PUBLIC_SUPABASE_* 未設定なら非表示) */}
      <div className="p-4 border-t border-border-subtle">
        <AuthPanel />
      </div>
    </nav>
  );
}
