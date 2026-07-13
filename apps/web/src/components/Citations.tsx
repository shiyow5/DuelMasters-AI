"use client";

import { useState } from "react";
import type { Citation } from "@/lib/types";
import { citationLabel, isPrimarySource, dedupeCitations } from "@/lib/citation";

/**
 * 回答の根拠を折りたたみで見せる。
 *
 * RAG ボットの回答は根拠を確認できて初めて信用できる。特に【裁定Q&A】には改定前の古い回答が
 * 混じっているため、どの資料に基づいた回答かをユーザーが判断できるようにする
 * (【総合ルール】が現行の一次情報)。
 */
export default function Citations({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  const items = dedupeCitations(citations);
  if (items.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-main"
      >
        <span className="material-symbols-outlined text-sm">
          {open ? "expand_less" : "expand_more"}
        </span>
        根拠 {items.length}件
      </button>

      {open && (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((c, i) => (
            <li
              key={i}
              className="rounded-lg border border-border-subtle bg-white/5 p-2.5 text-xs leading-relaxed"
            >
              <span
                className={`mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  isPrimarySource(c) ? "bg-primary/20 text-primary" : "bg-white/10 text-text-muted"
                }`}
              >
                {citationLabel(c)}
              </span>
              <p className="whitespace-pre-wrap text-text-muted">{c.text}</p>
              {typeof c.url === "string" && c.url !== "" && (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-[10px] text-primary underline"
                >
                  出典を開く
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
