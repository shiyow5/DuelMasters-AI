"use client";

import { useState, useRef, useEffect } from "react";
import { apiPost } from "@/lib/api";
import { getTime } from "@/lib/format";
import type { Message } from "@/lib/types";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const mode = "integrated";
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg: Message = {
      role: "user",
      content: input.trim(),
      timestamp: getTime(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await apiPost<{ response: string }>("/api/chat", {
        message: userMsg.content,
        mode,
        history: messages,
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.response, timestamp: getTime() },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `エラーが発生しました: ${err instanceof Error ? err.message : "不明なエラー"}`,
          timestamp: getTime(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadText, setLoadText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertTemplate(prefix: string) {
    setInput(prefix);
    textareaRef.current?.focus();
  }

  function handleExport() {
    if (messages.length === 0) return;
    const text = messages
      .map(
        (m) =>
          `[${m.timestamp ?? ""}] ${m.role === "user" ? "You" : "AI"}: ${m.content}`
      )
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate()
    ).padStart(2, "0")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `dm-ai-chat-${ymd}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDeleteChat() {
    if (confirm("チャット履歴を削除しますか?")) setMessages([]);
  }

  function applyLoadedDeck() {
    if (!loadText.trim()) return;
    setInput(`次のデッキを評価してください:\n${loadText.trim()}`);
    setLoadText("");
    setShowLoadModal(false);
    textareaRef.current?.focus();
  }

  return (
    <div className="flex-1 flex flex-col h-full relative">
      {/* Header */}
      <header className="px-6 py-4 border-b border-border-subtle flex items-center justify-between glass-panel">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30">
            <span className="material-symbols-outlined text-primary">
              psychology
            </span>
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              AI戦略アドバイザー
              <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold border border-primary/20 uppercase">
                Beta
              </span>
            </h2>
            <p className="text-xs text-text-muted">
              Gemini Based Duel Masters Engine
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            disabled={messages.length === 0}
            className="p-2 text-text-muted hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Export Chat"
          >
            <span className="material-symbols-outlined">ios_share</span>
          </button>
          <button
            onClick={handleDeleteChat}
            className="p-2 text-text-muted hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title="Delete Chat"
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center max-w-lg">
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30 mx-auto mb-4">
                <span className="material-symbols-outlined text-primary text-3xl">
                  psychology
                </span>
              </div>
              <h2 className="mb-2 text-2xl font-bold text-white">
                DM AI Master へようこそ
              </h2>
              <p className="text-text-muted text-sm mb-6">
                デュエル・マスターズに関する質問をどうぞ。ルール、デッキ構築、環境分析まで幅広くサポートします。
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  "S・トリガーの処理順を教えて",
                  "赤青マジックのデッキを評価して",
                  "今の環境のTier1は？",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="rounded-lg border border-border-highlight px-3 py-2 text-sm text-text-muted transition-colors hover:border-primary/50 hover:text-white bg-bg-surface"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div key={i} className="flex justify-end gap-4">
              <div className="flex flex-col items-end gap-1 max-w-[80%] lg:max-w-[60%]">
                <div className="glass-bubble-user p-4 rounded-2xl rounded-tr-sm text-text-main shadow-lg">
                  <p className="leading-relaxed whitespace-pre-wrap text-sm">
                    {msg.content}
                  </p>
                </div>
                <span className="text-[10px] text-text-dim">
                  You {msg.timestamp && `\u2022 ${msg.timestamp}`}
                </span>
              </div>
              <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-primary to-primary-purple flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white shadow-lg shadow-primary/20 mt-1">
                DU
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex-shrink-0 flex items-center justify-center border border-primary/30 mt-1">
                <span className="material-symbols-outlined text-primary text-sm">
                  psychology
                </span>
              </div>
              <div className="flex flex-col items-start gap-1 max-w-[80%] lg:max-w-[60%]">
                <div className="glass-bubble-ai p-5 rounded-2xl rounded-tl-sm text-text-main shadow-lg">
                  <p className="leading-relaxed whitespace-pre-wrap text-sm">
                    {msg.content}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-text-muted transition-colors border border-border-subtle">
                      <span className="material-symbols-outlined text-sm">
                        thumb_up
                      </span>
                      役に立った
                    </button>
                    <button
                      className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-text-muted transition-colors border border-border-subtle"
                      onClick={() =>
                        navigator.clipboard.writeText(msg.content)
                      }
                    >
                      <span className="material-symbols-outlined text-sm">
                        content_copy
                      </span>
                      コピー
                    </button>
                  </div>
                </div>
                <span className="text-[10px] text-text-dim">
                  AI Advisor {msg.timestamp && `\u2022 ${msg.timestamp}`}
                </span>
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex justify-start gap-4">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex-shrink-0 flex items-center justify-center border border-primary/30 mt-1">
              <span className="material-symbols-outlined text-primary text-sm">
                psychology
              </span>
            </div>
            <div className="glass-bubble-ai px-4 py-3 rounded-2xl rounded-tl-sm shadow-lg flex items-center gap-1">
              <div
                className="w-2 h-2 rounded-full bg-primary/50 animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <div
                className="w-2 h-2 rounded-full bg-primary/50 animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <div
                className="w-2 h-2 rounded-full bg-primary/50 animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input Area */}
      <div className="p-6 pt-2">
        <form
          onSubmit={handleSubmit}
          className="glass-panel rounded-2xl p-2 shadow-2xl ring-1 ring-white/10"
        >
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-2 pb-2 border-b border-border-subtle mb-2">
            <button
              type="button"
              onClick={() => setShowLoadModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">
                upload_file
              </span>
              デッキリスト読込
            </button>
            <button
              type="button"
              onClick={() => insertTemplate("カード検索: ")}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-white hover:bg-white/5 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">search</span>
              カード検索
            </button>
            <button
              type="button"
              onClick={() => insertTemplate("裁定確認: ")}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-white hover:bg-white/5 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">
                history_edu
              </span>
              裁定確認
            </button>
          </div>
          {/* Text Input */}
          <div className="relative flex items-end gap-2 px-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              className="w-full bg-transparent border-0 text-text-main placeholder-text-dim focus:ring-0 resize-none py-3 max-h-32 text-sm"
              placeholder="AIに質問する、またはデッキについて相談する..."
              rows={1}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="mb-1 p-2 bg-primary hover:bg-primary-dark text-bg-dark rounded-xl transition-colors shadow-lg shadow-primary/20 flex-shrink-0 disabled:opacity-50"
            >
              <span className="material-symbols-outlined">send</span>
            </button>
          </div>
        </form>
        <p className="text-center text-[10px] text-text-dim mt-2">
          AIは不正確な情報を生成する可能性があります。重要な大会ルール等は公式サイトで確認してください。
        </p>
      </div>

      {/* デッキリスト読込モーダル */}
      {showLoadModal && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setShowLoadModal(false)}
        >
          <div
            className="glass-panel rounded-2xl p-5 w-full max-w-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-bold mb-3">デッキリストを読み込む</h3>
            <textarea
              value={loadText}
              onChange={(e) => setLoadText(e.target.value)}
              rows={8}
              className="w-full bg-bg-dark border border-border-subtle rounded-lg p-3 text-sm text-text-main font-mono focus:ring-1 focus:ring-primary resize-none"
              placeholder={"4 ボルシャック・ドラゴン\n4 ナチュラル・トラップ\n..."}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setShowLoadModal(false)}
                className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-white hover:bg-white/5 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={applyLoadedDeck}
                disabled={!loadText.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-bg-dark hover:bg-primary-dark transition-colors disabled:opacity-50"
              >
                読み込む
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
