"use client";

import { useEffect, useState } from "react";
import { apiPost } from "@/lib/api";

interface DeckEntry {
  name: string;
  count: number;
}

/**
 * デッキのカード画像グリッド (#129)。
 *
 * デッキ内の各カードを画像で並べる。カード名 → 画像URL は `POST /api/card/resolve` で引く
 * (scorer は image_url を持っているが応答で捨てているため、専用の疎結合エンドポイントを使う)。
 *
 * - 画像は素の `<img loading="lazy">` (next/image は使わない。remotePatterns 未設定に依存しない)。
 * - **image_url を引けないカード名はテキスト枠にフォールバック** — 無関係画像や壊れ画像を出さない。
 * - 取得に失敗しても全カードがテキスト枠で出るだけ (グリッドは空にならない)。
 */
export default function DeckCardGrid({ entries }: { entries: DeckEntry[] }) {
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);

  // entries の中身が変わったときだけ引き直す (配列の参照ではなく内容をキーにする)。
  const key = entries.map((e) => `${e.count} ${e.name}`).join("\n");

  useEffect(() => {
    const names = [...new Set(entries.map((e) => e.name))];
    if (names.length === 0) {
      setImages({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiPost<{ cards: Array<{ name: string; image_url: string | null }> }>("/api/card/resolve", {
      names,
    })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string | null> = {};
        for (const c of res.cards) map[c.name] = c.image_url;
        setImages(map);
      })
      .catch(() => {
        // 失敗しても握り潰す。images が空のまま = 全カードがテキスト枠にフォールバックする。
        if (!cancelled) setImages({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // key は entries の内容ダイジェスト。entries を直接依存に置くと毎レンダーで再取得する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-text-dim">
        <p className="text-sm">デッキを評価・読込・自動構築するとカード画像が表示されます</p>
      </div>
    );
  }

  return (
    <div>
      {loading && <p className="mb-3 text-xs text-text-dim">カード画像を読み込み中...</p>}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
        {entries.map((entry, i) => {
          const url = images[entry.name];
          return (
            <div
              key={`${entry.name}-${i}`}
              className="relative aspect-[63/88] overflow-hidden rounded-md border border-border-highlight bg-bg-dark"
              title={entry.name}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- 外部 CDN の画像 (公式サイト)
                <img
                  src={url}
                  alt={entry.name}
                  loading="lazy"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center p-1.5 text-center text-[10px] leading-tight text-text-muted">
                  {entry.name}
                </div>
              )}
              {/* 枚数バッジ (1枚でも出す。デッキ内の採用枚数が一目で分かる) */}
              <span className="absolute bottom-1 right-1 rounded bg-bg-dark/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                ×{entry.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
