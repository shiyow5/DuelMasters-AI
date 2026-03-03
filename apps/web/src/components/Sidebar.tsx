"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

      {/* Bottom */}
      <div className="p-4 border-t border-border-subtle flex flex-col gap-2">
        <Link
          href="#"
          className="flex items-center gap-3 px-4 py-3 rounded-lg text-text-muted hover:text-white hover:bg-white/5 transition-colors"
        >
          <span className="material-symbols-outlined">settings</span>
          <span className="text-sm font-medium">設定</span>
        </Link>

        {/* User Profile */}
        <div className="mt-4 flex items-center gap-3 px-4 py-2 bg-white/5 rounded-xl border border-border-subtle">
          <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-primary to-primary-purple flex items-center justify-center text-[10px] font-bold text-white shadow-lg shadow-primary/20">
            DU
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-white">Guest User</span>
            <span className="text-[10px] text-primary">Free Plan</span>
          </div>
        </div>
      </div>
    </nav>
  );
}
