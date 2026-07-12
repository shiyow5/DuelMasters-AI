"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";

type SidebarContextValue = {
  open: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

/**
 * サイドバーのオフキャンバス開閉状態を共有する。
 * ヘッダーのハンバーガー(SidebarToggle)が開き、Sidebar 本体が表示する。
 */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSidebar = useCallback(() => setOpen(true), []);
  const closeSidebar = useCallback(() => setOpen(false), []);

  // オフキャンバス表示中は Esc キーで閉じられるようにする。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return (
    <SidebarContext.Provider value={{ open, openSidebar, closeSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar は SidebarProvider の内側で使用してください");
  return ctx;
}
