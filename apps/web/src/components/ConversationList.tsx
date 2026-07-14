"use client";

import { useState } from "react";
import type { ConversationSummary } from "@/lib/conversations";

/**
 * 会話一覧 (#110)。
 *
 * これまで会話は React の state にしか無く、**リロードすると全部消えていた**。
 */
export default function ConversationList({
  conversations,
  activeId,
  loading,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startRename(conv: ConversationSummary) {
    setRenamingId(conv.id);
    setDraft(conv.title);
  }

  function commitRename(id: string) {
    const title = draft.trim();
    // 空タイトルは無題の会話を生む。変更が無い場合と同様、単に何もしない。
    if (title !== "") onRename(id, title);
    setRenamingId(null);
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onNew}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-muted hover:text-white hover:bg-white/10 transition-colors"
      >
        <span className="material-symbols-outlined text-base">add</span>
        新しい会話
      </button>

      {loading && <p className="px-3 py-2 text-xs text-text-muted">読み込み中…</p>}

      {!loading && conversations.length === 0 && (
        <p className="px-3 py-2 text-xs text-text-muted">まだ会話がありません</p>
      )}

      <ul className="flex flex-col gap-0.5">
        {conversations.map((conv) => (
          <li key={conv.id} className="group relative">
            {renamingId === conv.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(conv.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white outline-none ring-1 ring-primary/50"
                aria-label="会話のタイトル"
              />
            ) : (
              <div
                className={`flex items-center rounded-lg transition-colors ${
                  activeId === conv.id ? "bg-primary/20 text-white" : "hover:bg-white/10"
                }`}
              >
                <button
                  onClick={() => onSelect(conv.id)}
                  className="flex-1 min-w-0 px-3 py-2 text-left"
                  title={conv.title}
                >
                  <span className="block truncate text-sm text-text-muted group-hover:text-white">
                    {conv.title}
                  </span>
                </button>
                {/* 操作ボタンはホバー時だけ出す (一覧が記号だらけになるのを避ける) */}
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startRename(conv)}
                    className="p-1.5 text-text-muted hover:text-white"
                    title="名前を変更"
                    aria-label={`「${conv.title}」の名前を変更`}
                  >
                    <span className="material-symbols-outlined text-sm">edit</span>
                  </button>
                  <button
                    onClick={() => onDelete(conv.id)}
                    className="p-1.5 pr-2 text-text-muted hover:text-red-400"
                    title="削除"
                    aria-label={`「${conv.title}」を削除`}
                  >
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
