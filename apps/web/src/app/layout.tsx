import type { Metadata } from "next";
import "./globals.css";
import { inter, notoSansJp, materialSymbols } from "./fonts";
import Sidebar from "@/components/Sidebar";
import { SidebarProvider } from "@/components/SidebarContext";

export const metadata: Metadata = {
  title: "DM-AI | デュエル・マスターズ Q&A ボット",
  description: "デュエル・マスターズのルール確認・デッキ構築支援・環境分析ができるAIアシスタント",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`dark ${inter.variable} ${notoSansJp.variable} ${materialSymbols.variable}`}
    >
      <body className="h-screen flex overflow-hidden bg-bg-dark text-text-main antialiased">
        <SidebarProvider>
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</div>
        </SidebarProvider>
      </body>
    </html>
  );
}
