"use client";

import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";

interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
  win_rate: number | null;
}

interface TierData {
  format: string;
  period: string;
  period_start: string;
  period_end: string;
  tier_data: TierEntry[];
}

const TIER_STYLES: Record<
  string,
  { accent: string; badge: string; valueColor: string }
> = {
  Tier1: {
    accent: "bg-gradient-to-b from-primary-purple to-primary-purple-light",
    badge: "bg-bg-card text-primary-purple-light",
    valueColor: "text-primary-purple-light",
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

const UNSPLASH_IMAGES = [
  "https://images.unsplash.com/photo-1642430098075-846d03425028?q=80&w=400&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1614726365723-49cfae968c92?q=80&w=400&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1544829728-e5cb9eedc20e?q=80&w=400&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1590422749842-a392b95b866c?q=80&w=400&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1476900966873-6713e85e5572?q=80&w=400&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?q=80&w=400&auto=format&fit=crop",
];

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
      <header className="border-b border-border-highlight bg-bg-dark px-10 py-3 sticky top-0 z-10 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-full bg-primary-purple flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-[20px]">
              playing_cards
            </span>
          </div>
          <h2 className="text-lg font-bold leading-tight tracking-tight text-white">
            環境分析
          </h2>
          <span className="px-2 py-1 rounded bg-primary-purple/20 text-primary-purple text-xs font-bold uppercase tracking-wider border border-primary-purple/30">
            Beta
          </span>
        </div>
        {/* Format Toggle */}
        <div className="flex h-10 items-center justify-center rounded-lg bg-bg-card p-1">
          {(["original", "advance"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={`px-6 h-full rounded text-sm font-bold transition-all duration-200 ${
                format === f
                  ? "bg-bg-dark text-primary-purple-light shadow-sm"
                  : "text-text-muted hover:text-white"
              }`}
            >
              {f === "original" ? "オリジナル" : "アドバンス"}
            </button>
          ))}
        </div>
      </header>

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
                最新のCS/大会結果に基づいたティアリストと勝率データ
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
                    ? "bg-primary-purple/20 text-primary-purple-light border border-primary-purple/30"
                    : "bg-bg-card hover:bg-bg-card-hover text-white"
                }`}
              >
                <span className="material-symbols-outlined text-[18px] text-text-muted">
                  calendar_today
                </span>
                <span className="text-sm font-medium">
                  過去{p.replace("w", "週間")}
                </span>
              </button>
            ))}
            {data && (
              <div className="ml-auto text-xs text-text-dim">
                期間: {data.period_start} 〜 {data.period_end}
              </div>
            )}
          </div>

          {loading && (
            <div className="py-12 text-center text-text-muted">
              読み込み中...
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-dm-fire/30 bg-dm-fire/10 p-4 text-sm text-dm-fire">
              {error}
            </div>
          )}

          {data && data.tier_data.length > 0 && (
            <>
              {(["Tier1", "Tier2"] as const).map((tier) => {
                const entries = data.tier_data.filter((e) => e.tier === tier);
                if (entries.length === 0) return null;
                const style = TIER_STYLES[tier];
                return (
                  <div key={tier} className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-8 w-1 rounded-full ${style.accent}`}
                      />
                      <h2 className="text-2xl font-bold text-white">{tier}</h2>
                      <span
                        className={`text-sm font-medium px-2 py-0.5 rounded ${style.badge}`}
                      >
                        使用率{" "}
                        {tier === "Tier1" ? "15%以上" : "5% - 15%"}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {entries.map((entry, i) => (
                        <DeckCard
                          key={i}
                          entry={entry}
                          tier={tier}
                          imageUrl={
                            UNSPLASH_IMAGES[i % UNSPLASH_IMAGES.length]
                          }
                        />
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
                      <h2 className="text-lg font-bold text-white">
                        Tier 3 / その他
                      </h2>
                      <span className="text-sm text-text-muted">
                        {
                          data.tier_data.filter((e) => e.tier === "Tier3")
                            .length
                        }{" "}
                        デッキタイプ
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
                          <DeckCard
                            key={i}
                            entry={entry}
                            tier="Tier3"
                            imageUrl={
                              UNSPLASH_IMAGES[
                                (i + 3) % UNSPLASH_IMAGES.length
                              ]
                            }
                          />
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
              <p className="text-text-muted">
                この期間のデータはまだありません
              </p>
              <p className="mt-2 text-sm text-text-dim">
                大会結果を登録するとティアリストが生成されます
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeckCard({
  entry,
  tier,
  imageUrl,
}: {
  entry: TierEntry;
  tier: string;
  imageUrl: string;
}) {
  const style = TIER_STYLES[tier] ?? TIER_STYLES.Tier3;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl bg-bg-card border border-border-highlight hover:border-primary-purple/50 transition-all cursor-pointer shadow-sm hover:shadow-lg hover:shadow-primary-purple/10">
      {/* Image Header */}
      <div className="h-32 w-full relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-bg-card to-transparent z-10" />
        <div
          className="w-full h-full bg-cover bg-center group-hover:scale-105 transition-transform duration-500 opacity-80"
          style={{ backgroundImage: `url('${imageUrl}')` }}
        />
      </div>

      <div className="flex flex-col p-4 -mt-12 relative z-20">
        {/* Civilization dots placeholder */}
        <div className="flex gap-1 mb-2">
          <span className="w-3 h-3 rounded-full bg-dm-fire shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
        </div>

        <h3 className="text-lg font-bold text-white mb-1 truncate">
          {entry.archetype}
        </h3>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2 py-3 border-t border-border-highlight/50 mt-2">
          <div className="flex flex-col">
            <span className="text-xs text-text-muted">使用率</span>
            <span className={`text-lg font-bold ${style.valueColor}`}>
              {entry.usage_rate}%
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-text-muted">勝率</span>
            <span
              className={`text-lg font-bold ${
                entry.win_rate !== null
                  ? entry.win_rate >= 50
                    ? "text-emerald-500"
                    : "text-dm-light"
                  : "text-text-dim"
              }`}
            >
              {entry.win_rate !== null ? `${entry.win_rate}%` : "--"}
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
