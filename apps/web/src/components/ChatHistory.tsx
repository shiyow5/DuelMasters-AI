"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import ConversationList from "./ConversationList";
import {
  listConversations,
  renameConversation,
  deleteConversation,
  type ConversationSummary,
} from "@/lib/conversations";

/**
 * サイドバーの会話一覧 (#110)。
 *
 * ## 会話の選択は URL (`/?c=<id>`) で行う
 *
 * サイドバーは全ページ共通のナビで、チャットページとは別のツリーにいる。React の state を
 * 共有させると結合が増えるので、**URL を唯一の情報源**にする。副次的に、会話をブックマーク
 * できるようにもなる。
 *
 * ## 更新の合図は custom event
 *
 * チャットページが新しい会話を作った時に、一覧を貼り直す必要がある。context を足すほどの
 * ものではないので `conversations:changed` を投げてもらう。
 */
export const CONVERSATIONS_CHANGED = "conversations:changed";

/** 会話一覧を貼り直させる (チャットページが会話を作った時などに呼ぶ)。 */
export function notifyConversationsChanged() {
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
}

export default function ChatHistory({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const activeId = params.get("c");

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      // 未ログインなら 401。一覧を出さないだけで、エラーとしては見せない
      // (ログイン導線は AuthPanel が出す)。
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(CONVERSATIONS_CHANGED, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, refresh);
  }, [refresh]);

  function select(id: string) {
    router.push(`/?c=${id}`);
    onNavigate?.();
  }

  function startNew() {
    router.push("/");
    onNavigate?.();
  }

  async function rename(id: string, title: string) {
    // 楽観更新。失敗したら refresh が正しい状態に戻す。
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await renameConversation(id, title);
    } finally {
      void refresh();
    }
  }

  async function remove(id: string) {
    if (!confirm("この会話を削除しますか? 元に戻せません。")) return;
    try {
      await deleteConversation(id);
    } finally {
      // 開いている会話を消したら、チャットを新規状態に戻す
      // (消えた会話 ID が URL に残ると、読み込みが 404 になる)。
      if (activeId === id && pathname === "/") router.push("/");
      void refresh();
    }
  }

  return (
    <ConversationList
      conversations={conversations}
      activeId={activeId}
      loading={loading}
      onSelect={select}
      onNew={startNew}
      onRename={rename}
      onDelete={remove}
    />
  );
}
