"use client";

import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";
import { nameToHue } from "@/lib/format";
import type { TierEntry, TierData } from "@/lib/types";
import Header from "@/components/Header";
import ErrorDisplay from "@/components/ErrorDisplay";

const TIER_STYLES: Record<string, { accent: string; badge: string; valueColor: string }> = {
  Tier1: {
    accent: "bg-gradient-to-b from-primary to-primary-dark",
    badge: "bg-bg-card text-primary",
    valueColor: "text-primary",
  },
  Tier2: {
    accent: "bg-bg-surface-highlight",
    badge: "bg-bg-card text-text-muted",
    valueColor: "text-text-main",
  },
  Tier3: {
    accent: "bg-text-dim",
    badge: "bg-bg-card text-text-dim",
    valueColor: "text-text-muted",
  },
};

export default function MetaPage() {
  const [format, setFormat] = useState<"original" | "advance">("original");
  const [period, setPeriod] = useState("4w");
  const [data, setData] = useState<TierData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showTier3, setShowTier3] = useState(false);

  useEffect(() => {
    fetchTierData();
  }, [format, period]);

  async function fetchTierData() {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<TierData>("/api/meta/tier", { format, period });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <Header
        left={
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <span className="material-symbols-outlined text-bg-dark text-[20px]">
                playing_cards
              </span>
            </div>
            <h2 className="text-lg font-bold leading-tight tracking-tight text-white">環境分析</h2>
            <span className="px-2 py-1 rounded bg-primary/20 text-primary text-xs font-bold uppercase tracking-wider border border-primary/30">
              Beta
            </span>
          </div>
        }
        right={
          <div className="flex h-10 items-center justify-center rounded-lg bg-bg-card p-1">
            {(["original", "advance"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-6 h-full rounded text-sm font-bold transition-all duration-200 ${
                  format === f
                    ? "bg-bg-dark text-primary shadow-sm"
                    : "text-text-muted hover:text-white"
                }`}
              >
                {f === "original" ? "オリジナル" : "アドバンス"}
              </button>
            ))}
          </div>
        }
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-8 py-8 space-y-6">
          {/* Title & Description */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-4xl font-black leading-tight tracking-tight text-white">
                環境分析
              </h1>
              <p className="text-text-muted text-base mt-1">
                {/* **勝率は取込元に存在しない** (#122)。出せないものを謳わない。 */}
                最新のCS入賞データに基づいたティアリスト (使用率・入賞数)
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-3 flex-wrap items-center border-b border-border-highlight pb-6">
            {(["2w", "4w", "8w"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`flex h-9 items-center justify-center gap-x-2 rounded-lg px-4 transition-colors ${
                  period === p
                    ? "bg-primary/20 text-primary border border-primary/30"
                    : "bg-bg-card hover:bg-bg-card-hover text-white"
                }`}
              >
                <span className="material-symbols-outlined text-[18px] text-text-muted">
                  calendar_today
                </span>
                <span className="text-sm font-medium">過去{p.replace("w", "週間")}</span>
              </button>
            ))}
            {data && (
              <div className="ml-auto text-xs text-text-dim">
                期間: {data.period_start} 〜 {data.period_end}
              </div>
            )}
          </div>

          {loading && <div className="py-12 text-center text-text-muted">読み込み中...</div>}

          {error && <ErrorDisplay message={error} variant="error" />}

          {data && data.tier_data.length > 0 && (
            <>
              {(["Tier1", "Tier2"] as const).map((tier) => {
                const entries = data.tier_data.filter((e) => e.tier === tier);
                if (entries.length === 0) return null;
                const style = TIER_STYLES[tier];
                return (
                  <div key={tier} className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <div className={`h-8 w-1 rounded-full ${style.accent}`} />
                      <h2 className="text-2xl font-bold text-white">{tier}</h2>
                      <span className={`text-sm font-medium px-2 py-0.5 rounded ${style.badge}`}>
                        使用率{" "}
                        {/* 閾値は apps/api の TIER_THRESHOLDS (15% / 8%) と一致させること */}
                        {tier === "Tier1" ? "15%以上" : "8% - 15%"}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {entries.map((entry, i) => (
                        <DeckCard key={i} entry={entry} tier={tier} />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Tier 3 Collapsible */}
              {data.tier_data.filter((e) => e.tier === "Tier3").length > 0 && (
                <div className="flex flex-col gap-4 mt-8 pb-10">
                  <button
                    onClick={() => setShowTier3(!showTier3)}
                    className="flex items-center justify-between w-full p-4 rounded-xl bg-bg-card hover:bg-bg-card-hover transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-6 w-1 bg-text-dim rounded-full" />
                      <h2 className="text-lg font-bold text-white">Tier 3 / その他</h2>
                      <span className="text-sm text-text-muted">
                        {data.tier_data.filter((e) => e.tier === "Tier3").length} デッキタイプ
                      </span>
                    </div>
                    <span
                      className={`material-symbols-outlined text-text-muted group-hover:text-white transition-all ${showTier3 ? "rotate-180" : ""}`}
                    >
                      expand_more
                    </span>
                  </button>
                  {showTier3 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {data.tier_data
                        .filter((e) => e.tier === "Tier3")
                        .map((entry, i) => (
                          <DeckCard key={i} entry={entry} tier="Tier3" />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {data && data.tier_data.length === 0 && (
            <div className="py-12 text-center">
              <span className="material-symbols-outlined text-5xl text-text-dim mb-4 block">
                monitoring
              </span>
              <p className="text-text-muted">この期間のデータはまだありません</p>
              <p className="mt-2 text-sm text-text-dim">
                大会結果を登録するとティアリストが生成されます
              </p>
            </div>
          )}

          {/* 出典表示。CS の入賞数集計は田園補完計画の週次ランキング記事から取り込んでいる。 */}
          {data && data.tier_data.length > 0 && (
            <p className="mt-6 border-t border-border-highlight/50 pt-4 text-xs text-text-dim">
              大会結果の出典:{" "}
              <a
                href="https://supersolenoid.jp/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-text-muted"
              >
                田園補完計画 第十七次中間報告書
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DeckCard({ entry, tier }: { entry: TierEntry; tier: string }) {
  const style = TIER_STYLES[tier] ?? TIER_STYLES.Tier3;
  const hue = nameToHue(entry.archetype);

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl bg-bg-card border border-border-highlight transition-all shadow-sm">
      {/* Header: メインカードの画像 (#122)。引けなければアーキタイプ名から作るグラデーション */}
      <div className="h-32 w-full relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-bg-card to-transparent z-10" />
        {entry.main_card ? (
          // カード画像は縦長。上部 (イラスト部分) が見えるように object-top で寄せる。
          // eslint-disable-next-line @next/next/no-img-element -- 外部 CDN の画像 (公式サイト)
          <img
            src={entry.main_card.image_url}
            alt={entry.main_card.name}
            title={entry.main_card.name}
            loading="lazy"
            className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div
            className="w-full h-full group-hover:scale-105 transition-transform duration-500 opacity-80"
            style={{
              background: `linear-gradient(135deg, hsl(${hue} 60% 35%), hsl(${(hue + 40) % 360} 60% 20%))`,
            }}
          />
        )}
      </div>

      <div className="flex flex-col p-4 -mt-12 relative z-20">
        <h3 className="text-lg font-bold text-white mb-1 truncate">{entry.archetype}</h3>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2 py-3 border-t border-border-highlight/50 mt-2">
          <div className="flex flex-col">
            <span className="text-xs text-text-muted">使用率</span>
            <span className={`text-lg font-bold ${style.valueColor}`}>{entry.usage_rate}%</span>
          </div>
          {/*
            **勝率は出せないので出さない** (#122)。
            取込元 (公認 CS の結果記事) には順位しか載っておらず、勝敗が無い。そもそも
            入賞デッキしか分からないので、負けたデッキの母集団が存在せず原理的に計算できない。
            以前は常に「--」を表示していた。**実データで裏付けられる入賞数に置き換える。**
          */}
          <div className="flex flex-col">
            <span className="text-xs text-text-muted">入賞数</span>
            <span className={`text-lg font-bold ${style.valueColor}`}>
              {entry.entries}
              <span className="text-xs font-normal text-text-muted">/{entry.total_entries}</span>
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-text-muted">Tier</span>
            <span className="text-sm font-bold text-text-main">{tier}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
