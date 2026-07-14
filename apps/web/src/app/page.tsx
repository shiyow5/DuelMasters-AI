"use client";

import { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { streamChat } from "@/lib/api";
import { getTime } from "@/lib/format";
import { initialStatus, toolErrorLabel } from "@/lib/tools";
import { applyChatEvent } from "@/lib/chat-state";
import { toMessages, canSendFeedback } from "@/lib/conversation-state";
import {
  createConversation,
  getConversation,
  sendFeedback,
  titleFromMessage,
} from "@/lib/conversations";
import { notifyConversationsChanged } from "@/components/ChatHistory";
import type { Message } from "@/lib/types";
import Header from "@/components/Header";
import ChatBubble, { TypingDots } from "@/components/ChatBubble";
import Citations from "@/components/Citations";
import Markdown from "@/components/Markdown";

/** useSearchParams は Suspense 境界の内側でしか使えない (Next の CSR bailout)。 */
export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <Chat />
    </Suspense>
  );
}

function Chat() {
  const router = useRouter();
  const params = useSearchParams();
  /** URL が唯一の情報源 (#110)。`/?c=<id>` で会話を開く。 */
  const conversationId = params.get("c");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const mode = "integrated";
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * URL の会話 ID が変わったら、その会話を読み直す (#110)。
   *
   * **送信直後に自分で push した ID でも読み直す**と、いま出したばかりの回答が一瞬消える。
   * 送信中 (loading) は読み直さないことで防ぐ。
   */
  const loadConversation = useCallback(
    async (id: string | null) => {
      if (!id) {
        setMessages([]);
        return;
      }
      try {
        const conv = await getConversation(id);
        setMessages(toMessages(conv.messages));
      } catch {
        // 消された会話 / 他人の会話 → 404。新規状態に戻す (URL に死んだ ID を残さない)。
        setMessages([]);
        router.replace("/");
      }
    },
    [router],
  );

  const streamingRef = useRef(false);
  useEffect(() => {
    if (streamingRef.current) return;
    void loadConversation(conversationId);
  }, [conversationId, loadConversation]);

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

    const text = input.trim();
    const userMsg: Message = { role: "user", content: text, timestamp: getTime() };
    // 履歴は「今回のユーザー発話を含まない」状態を送る (api 側で message として別に渡すため)。
    // **会話 ID がある場合、この history はサーバーに無視される** — 履歴は DB が正 (#110)。
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
    streamingRef.current = true;

    try {
      // 会話がまだ無ければ作る。**タイトルは最初の質問から作る** (LLM は呼ばない)。
      // 未ログインなら 401 で失敗するので、その場合は会話を持たずに続行する
      // (保存はされないが、チャット自体は今までどおり動く)。
      let cid = conversationId;
      if (!cid) {
        cid = await createConversation(titleFromMessage(text), mode)
          .then((c) => c.id)
          .catch(() => null);
        if (cid) {
          // URL を差し替える。**replace を使う** — 送信のたびに履歴が積もると
          // 戻るボタンで会話が消えたように見える。
          router.replace(`/?c=${cid}`);
          notifyConversationsChanged();
        }
      }

      // 進行表示の分岐は applyChatEvent (純関数) に切り出してある。
      // イベントの順序で表示が破綻しないことは chat-state.test.ts で固定している。
      await streamChat({ message: text, mode, history, conversationId: cid ?? undefined }, (ev) => {
        updateLast((m) => applyChatEvent(m, ev));
      });
      notifyConversationsChanged();
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
      streamingRef.current = false;
    }
  }

  /** 「役に立った / 立たなかった」を保存する (#110)。捨てていたシグナルを拾う。 */
  async function handleFeedback(index: number, helpful: boolean) {
    const msg = messages[index];
    if (!canSendFeedback(msg, conversationId)) return;
    // 楽観更新。失敗しても押し直せるよう、エラーでは元に戻す。
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, helpful } : m)));
    try {
      await sendFeedback(conversationId!, msg.id!, helpful);
    } catch {
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, helpful: undefined } : m)));
    }
  }

  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadText, setLoadText] = useState("");
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

  /**
   * 会話を閉じて新規状態に戻す。
   * **DB からは消さない** — 消すのはサイドバーの削除ボタン (誤操作で会話を失わせない)。
   */
  function handleNewChat() {
    setMessages([]);
    router.replace("/");
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
              onClick={handleNewChat}
              className="p-2 text-text-muted hover:text-white hover:bg-white/10 rounded-lg transition-colors"
              title="新しい会話"
            >
              <span className="material-symbols-outlined">add_comment</span>
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
                  {/* ツールが失敗したことを隠さない (#109)。握り潰すと、データで裏付け
                      られていない回答が「普通の回答」に見えてしまう。 */}
                  {msg.toolFailures && msg.toolFailures.length > 0 && (
                    <div
                      role="status"
                      className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
                    >
                      <span className="material-symbols-outlined text-sm">warning</span>
                      <span>{toolErrorLabel(msg.toolFailures)}</span>
                    </div>
                  )}
                  {msg.citations && msg.citations.length > 0 && (
                    <Citations citations={msg.citations} />
                  )}
                  {!msg.error && (
                    <div className="mt-4 flex gap-2">
                      {/* 評価は DB に保存する (#110)。低評価は eval の golden set 候補になる。
                          保存されていない発言 (未ログイン等) には出さない。 */}
                      {canSendFeedback(msg, conversationId) && (
                        <>
                          <button
                            onClick={() => handleFeedback(i, true)}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-border-subtle ${
                              msg.helpful === true ? "text-primary" : "text-text-muted"
                            }`}
                            aria-pressed={msg.helpful === true}
                          >
                            <span className="material-symbols-outlined text-sm">thumb_up</span>
                            {msg.helpful === true ? "ありがとうございます" : "役に立った"}
                          </button>
                          <button
                            onClick={() => handleFeedback(i, false)}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-border-subtle ${
                              msg.helpful === false ? "text-red-400" : "text-text-muted"
                            }`}
                            aria-pressed={msg.helpful === false}
                            title="この回答は正しくない / 役に立たなかった"
                          >
                            <span className="material-symbols-outlined text-sm">thumb_down</span>
                            {msg.helpful === false ? "報告しました" : "役に立たなかった"}
                          </button>
                        </>
                      )}
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
            ) : msg.role === "assistant" && !msg.error ? (
              // エージェントの回答だけ Markdown で描画する (#100)。
              // **エラー文はプレーンのまま。** LLM 由来ではないので Markdown を通す意味がなく、
              // 通すと記号が勝手に解釈される。ユーザーの発話も同様にプレーン。
              <div className={msg.streaming ? "animate-none" : ""}>
                <Markdown>{msg.content}</Markdown>
                {msg.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
              </div>
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
