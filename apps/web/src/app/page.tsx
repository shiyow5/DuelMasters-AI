"use client";

import { useState, useRef, useEffect } from "react";
import { streamChat } from "@/lib/api";
import { getTime } from "@/lib/format";
import { toolLabel, phaseLabel, initialStatus } from "@/lib/tools";
import type { Message } from "@/lib/types";
import Header from "@/components/Header";
import ChatBubble, { TypingDots } from "@/components/ChatBubble";
import Citations from "@/components/Citations";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const mode = "integrated";
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /** ストリーミング中の最後の 1件 (assistant) だけを更新する */
  function updateLast(patch: (m: Message) => Message) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = patch(next[next.length - 1]);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: "user", content: input.trim(), timestamp: getTime() };
    // 履歴は「今回のユーザー発話を含まない」状態を送る (api 側で message として別に渡すため)
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      userMsg,
      {
        role: "assistant",
        content: "",
        timestamp: getTime(),
        streaming: true,
        // 最初のイベントが届くまで数秒かかる。三点リーダーだけだと固まったように見えるので、
        // その間の文言を先に置く (#98)。
        status: initialStatus(mode),
      },
    ]);
    setInput("");
    setLoading(true);

    try {
      await streamChat({ message: userMsg.content, mode, history }, (ev) => {
        switch (ev.type) {
          case "token":
            updateLast((m) => ({ ...m, content: m.content + ev.text }));
            break;
          case "phase": {
            // ノードを通過した「あと」に届く。画面には「次に何をしているか」を出す。
            // トークンが流れ始めていたら上書きしない (回答が出ている最中に進行表示へ戻ると
            // ちらつくうえ、回答が消えたように見える)。
            const label = phaseLabel(ev.node);
            if (label) updateLast((m) => (m.content === "" ? { ...m, status: label } : m));
            break;
          }
          case "tool":
            // ツールを呼ぶ前にエージェントが前置きを喋ることがある。その分は捨てて
            // 「今なにをしているか」に差し替える (最終的な回答は done で確定する)。
            updateLast((m) => ({
              ...m,
              content: "",
              status: toolLabel(ev.name, ev.args ?? {}),
            }));
            break;
          case "done":
            updateLast((m) => ({
              ...m,
              content: ev.result.response,
              citations: ev.result.citations,
              toolCalls: ev.result.toolCalls,
              streaming: false,
              status: undefined,
            }));
            break;
          case "error":
            updateLast((m) => ({
              ...m,
              content: ev.message,
              streaming: false,
              status: undefined,
              error: true,
            }));
            break;
        }
      });
    } catch (err) {
      updateLast((m) => ({
        ...m,
        content: err instanceof Error ? err.message : "エラーが発生しました",
        streaming: false,
        status: undefined,
        error: true,
      }));
    } finally {
      setLoading(false);
    }
  }

  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadText, setLoadText] = useState("");
  const [helpful, setHelpful] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertTemplate(prefix: string) {
    setInput(prefix);
    textareaRef.current?.focus();
  }

  function handleExport() {
    if (messages.length === 0) return;
    const text = messages
      .map((m) => `[${m.timestamp ?? ""}] ${m.role === "user" ? "You" : "AI"}: ${m.content}`)
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate(),
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
      <Header
        left={
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30">
              <span className="material-symbols-outlined text-primary">psychology</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                AI戦略アドバイザー
                <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold border border-primary/20 uppercase">
                  Beta
                </span>
              </h2>
              <p className="text-xs text-text-muted">Gemini Based Duel Masters Engine</p>
            </div>
          </div>
        }
        right={
          <>
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
          </>
        }
      />

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center max-w-lg">
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30 mx-auto mb-4">
                <span className="material-symbols-outlined text-primary text-3xl">psychology</span>
              </div>
              <h2 className="mb-2 text-2xl font-bold text-white">DM AI Master へようこそ</h2>
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

        {messages.map((msg, i) => (
          <ChatBubble
            key={i}
            role={msg.role}
            name={msg.role === "user" ? "You" : "AI Advisor"}
            timestamp={msg.timestamp}
            aiIcon="psychology"
            footer={
              // ストリーミング中はまだ回答が確定していないので、根拠もフィードバックも出さない
              msg.role === "assistant" && !msg.streaming ? (
                <>
                  {msg.citations && msg.citations.length > 0 && (
                    <Citations citations={msg.citations} />
                  )}
                  {!msg.error && (
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => setHelpful((prev) => new Set(prev).add(i))}
                        disabled={helpful.has(i)}
                        className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-text-muted transition-colors border border-border-subtle disabled:text-primary disabled:opacity-100"
                      >
                        <span className="material-symbols-outlined text-sm">thumb_up</span>
                        {helpful.has(i) ? "ありがとうございます" : "役に立った"}
                      </button>
                      <button
                        className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-text-muted transition-colors border border-border-subtle"
                        onClick={async () => {
                          await navigator.clipboard.writeText(msg.content);
                          setCopiedIdx(i);
                        }}
                      >
                        <span className="material-symbols-outlined text-sm">content_copy</span>
                        {copiedIdx === i ? "コピーしました" : "コピー"}
                      </button>
                    </div>
                  )}
                </>
              ) : undefined
            }
          >
            {/* いま何をしているか。回答が流れ始めたら消す (進行表示が残ると回答と二重に見える)。 */}
            {msg.streaming && msg.status && msg.content === "" && (
              <p className="flex items-center gap-1.5 text-xs text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">
                  progress_activity
                </span>
                {msg.status}…
              </p>
            )}
            {msg.content === "" && msg.streaming ? (
              // 進行状況が出ているときは三点リーダーを出さない (二重の「待ってます」表示になる)。
              // status が無いのは、イベントが1つも来ていない一瞬だけ。
              msg.status ? null : (
                <TypingDots />
              )
            ) : (
              <p
                className={`leading-relaxed whitespace-pre-wrap text-sm ${
                  msg.error ? "text-danger" : ""
                }`}
              >
                {msg.content}
                {msg.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
              </p>
            )}
          </ChatBubble>
        ))}

        {/* 応答中のバブルは messages に streaming フラグ付きで積んであるので、
            ここで別途ローディング表示は出さない (二重になる) */}
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
              <span className="material-symbols-outlined text-sm">upload_file</span>
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
              <span className="material-symbols-outlined text-sm">history_edu</span>
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
