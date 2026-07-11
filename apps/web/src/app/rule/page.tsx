"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import { getTime } from "@/lib/format";
import type { Citation, Message } from "@/lib/types";

const COMMON_KEYWORDS = [
  "マッハファイター",
  "W・ブレイカー",
  "S・トリガー",
  "ガードマン",
  "ジャストダイバー",
  "革命チェンジ",
  "侵略",
  "G・ストライク",
];

export default function RulePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeKeyword, setActiveKeyword] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    const userMsg: Message = {
      role: "user",
      content: query.trim(),
      timestamp: getTime(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setQuery("");
    setLoading(true);

    try {
      const res = await apiPost<{ response: string; citations?: Citation[] }>(
        "/api/chat",
        { message: userMsg.content, mode: "rule" }
      );
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.response,
          citations: res.citations,
          timestamp: getTime(),
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
          timestamp: getTime(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="h-16 border-b border-border-subtle bg-bg-dark/80 backdrop-blur-md flex items-center justify-between px-8">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-bold text-white tracking-tight">
            AIルール審査員
          </h2>
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-primary-purple text-white uppercase tracking-wider">
            Beta
          </span>
        </div>
      </header>

      {/* Split View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col min-w-0 bg-bg-dark relative">
          {/* Chat History */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
            {/* Welcome */}
            {messages.length === 0 && (
              <div className="flex gap-4 max-w-3xl mx-auto w-full">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center border border-border-subtle">
                  <span className="material-symbols-outlined text-primary-purple text-xl">
                    smart_toy
                  </span>
                </div>
                <div className="flex flex-col gap-2 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold text-text-main">
                      AIジャッジ
                    </span>
                    <span className="text-xs text-text-dim">{getTime()}</span>
                  </div>
                  <div className="p-4 rounded-2xl rounded-tl-none glass-bubble-ai-purple text-text-main leading-relaxed shadow-sm">
                    <p>
                      こんにちは！デュエル・マスターズのルールについて何か質問はありますか？
                      <br />
                      カードの効果処理、タイミング、キーワード能力など、何でも聞いてください。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <div
                  key={i}
                  className="flex gap-4 flex-row-reverse max-w-3xl mx-auto w-full"
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-tr from-primary to-primary-purple flex items-center justify-center text-[10px] font-bold text-white">
                    DU
                  </div>
                  <div className="flex flex-col gap-2 items-end flex-1">
                    <div className="flex items-baseline gap-2 flex-row-reverse">
                      <span className="text-sm font-bold text-text-main">
                        あなた
                      </span>
                      <span className="text-xs text-text-dim">
                        {msg.timestamp}
                      </span>
                    </div>
                    <div className="p-4 rounded-2xl rounded-tr-none bg-primary-purple text-white leading-relaxed shadow-lg shadow-primary-purple/10">
                      <p className="whitespace-pre-wrap text-sm">
                        {msg.content}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="flex gap-4 max-w-3xl mx-auto w-full"
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center border border-border-subtle">
                    <span className="material-symbols-outlined text-primary-purple text-xl">
                      smart_toy
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-text-main">
                        AIジャッジ
                      </span>
                      <span className="text-xs text-text-dim">
                        {msg.timestamp}
                      </span>
                    </div>
                    <div className="p-4 rounded-2xl rounded-tl-none glass-bubble-ai-purple text-text-main leading-relaxed shadow-sm">
                      <p className="whitespace-pre-wrap text-sm">
                        {msg.content}
                      </p>
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-white/5 flex flex-wrap gap-2">
                          {msg.citations.map((c, ci) => (
                            <button
                              key={ci}
                              className="text-xs bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-full transition-colors text-text-muted"
                              onClick={() => setActiveKeyword(c.text)}
                            >
                              {c.article && `条${c.article}: `}
                              {c.text.slice(0, 30)}...
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            )}

            {loading && (
              <div className="flex gap-4 max-w-3xl mx-auto w-full">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center border border-border-subtle">
                  <span className="material-symbols-outlined text-primary-purple text-xl">
                    smart_toy
                  </span>
                </div>
                <div className="glass-bubble-ai-purple px-4 py-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1">
                  <div
                    className="w-2 h-2 rounded-full bg-primary-purple/50 animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <div
                    className="w-2 h-2 rounded-full bg-primary-purple/50 animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  />
                  <div
                    className="w-2 h-2 rounded-full bg-primary-purple/50 animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-6 bg-bg-dark border-t border-border-subtle">
            <form onSubmit={handleSearch} className="max-w-3xl mx-auto relative">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSearch(e);
                  }
                }}
                className="w-full bg-bg-surface border border-border-subtle rounded-xl px-4 py-4 pr-12 text-white placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-purple focus:border-transparent resize-none shadow-lg text-sm"
                placeholder="ルールの質問を入力してください... (例: マッハファイターとは？)"
                rows={2}
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="absolute right-3 bottom-3 p-2 bg-primary-purple hover:bg-primary-purple/90 text-white rounded-lg transition-colors flex items-center justify-center shadow-lg shadow-primary-purple/20 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[20px]">
                  send
                </span>
              </button>
            </form>
            <p className="text-center text-xs text-text-dim mt-3">
              AIは誤った情報を生成する可能性があります。公式ルールも必ずご確認ください。
            </p>
          </div>
        </div>

        {/* Right: Quick Reference Panel */}
        <aside className="w-96 bg-bg-card border-l border-border-subtle flex flex-col overflow-hidden hidden xl:flex">
          <div className="p-5 border-b border-border-subtle">
            <h3 className="text-white font-bold text-lg flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-purple">
                menu_book
              </span>
              クイックリファレンス
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* Active Keyword */}
            {activeKeyword && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-primary-purple font-bold text-sm uppercase tracking-wider">
                    選択中の引用
                  </h4>
                  <button
                    onClick={() => setActiveKeyword(null)}
                    className="text-text-dim hover:text-white"
                  >
                    <span className="material-symbols-outlined text-sm">
                      close
                    </span>
                  </button>
                </div>
                <div className="bg-bg-surface/50 border border-primary-purple/30 rounded-lg p-4">
                  <p className="text-sm text-text-main leading-relaxed">
                    {activeKeyword}
                  </p>
                </div>
              </div>
            )}

            {/* Common Keywords */}
            <div>
              <h4 className="text-text-muted font-bold text-xs uppercase tracking-wider mb-3">
                よく検索される用語
              </h4>
              <div className="flex flex-wrap gap-2">
                {COMMON_KEYWORDS.map((kw) => (
                  <button
                    key={kw}
                    onClick={() => setQuery(kw + "とは？")}
                    className="px-3 py-1.5 rounded-md bg-bg-surface border border-border-subtle text-xs text-text-muted hover:border-primary-purple/50 hover:text-white cursor-pointer transition-colors"
                  >
                    {kw}
                  </button>
                ))}
              </div>
            </div>

            {/* Official Link */}
            <div className="mt-4 p-4 rounded-xl bg-gradient-to-r from-primary-purple/10 to-transparent border border-primary-purple/20">
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-primary-purple/20 p-2 rounded-lg text-primary-purple">
                  <span className="material-symbols-outlined">gavel</span>
                </div>
                <h5 className="text-white font-bold text-sm">公式総合ルール</h5>
              </div>
              <p className="text-xs text-text-muted mb-3">
                最新の総合ルールPDFを確認します。
              </p>
              <a
                href="https://dm.takaratomy.co.jp/rule/rulechange/"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-2 bg-bg-surface hover:bg-primary-purple hover:text-white border border-border-subtle hover:border-primary-purple/50 text-text-main text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-2"
              >
                PDFを開く
                <span className="material-symbols-outlined text-[16px]">
                  open_in_new
                </span>
              </a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
