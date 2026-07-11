"use client";

import { useState, useEffect, useCallback } from "react";
import { apiPost, apiGet, apiDelete } from "@/lib/api";
import { scoreGrade } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import type {
  DeckScore,
  ValidationResult,
  SavedDeckSummary,
} from "@/lib/types";
import { CIV_COLORS, CIV_LABELS, CIV_HEX } from "@/lib/civ";

export default function DeckPage() {
  const [decklist, setDecklist] = useState("");
  const [theme, setTheme] = useState("");
  const [format, setFormat] = useState<"original" | "advance">("original");
  const [score, setScore] = useState<DeckScore | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [buildResult, setBuildResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [myDecks, setMyDecks] = useState<SavedDeckSummary[]>([]);
  const [loggedIn, setLoggedIn] = useState(false);

  const refreshMyDecks = useCallback(async () => {
    if (!supabase) {
      setLoggedIn(false);
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setLoggedIn(false);
      setMyDecks([]);
      return;
    }
    setLoggedIn(true);
    try {
      const res = await apiGet<{ decks: SavedDeckSummary[] }>("/api/deck/list");
      setMyDecks(res.decks);
    } catch {
      setMyDecks([]);
    }
  }, []);

  useEffect(() => {
    refreshMyDecks();
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      refreshMyDecks();
    });
    return () => sub.subscription.unsubscribe();
  }, [refreshMyDecks]);

  async function handleSave() {
    if (!title.trim() || !score) return;
    setSaveMsg("");
    try {
      await apiPost("/api/deck/save", {
        title: title.trim(),
        format,
        decklist,
      });
      setSaveMsg("保存しました");
      setTitle("");
      await refreshMyDecks();
    } catch (err) {
      setSaveMsg(
        `保存に失敗しました: ${err instanceof Error ? err.message : "不明"}`
      );
    }
  }

  async function loadDeck(id: number) {
    try {
      const deck = await apiGet<{
        cards: Array<{ name: string; count: number }>;
      }>(`/api/deck/${id}`);
      setDecklist(deck.cards.map((c) => `${c.count} ${c.name}`).join("\n"));
      setScore(null);
      setValidation(null);
      setBuildResult("");
    } catch (err) {
      alert(
        `読み込みに失敗しました: ${err instanceof Error ? err.message : "不明"}`
      );
    }
  }

  async function deleteDeck(id: number) {
    if (!confirm("このデッキを削除しますか?")) return;
    try {
      await apiDelete(`/api/deck/${id}`);
      await refreshMyDecks();
    } catch (err) {
      alert(
        `削除に失敗しました: ${err instanceof Error ? err.message : "不明"}`
      );
    }
  }

  async function handleEvaluate(e: React.FormEvent) {
    e.preventDefault();
    if (!decklist.trim() || loading) return;
    setLoading(true);
    setScore(null);
    setValidation(null);
    try {
      const res = await apiPost<{
        score: DeckScore;
        validation: ValidationResult;
      }>("/api/deck/evaluate", { decklist, format });
      setScore(res.score);
      setValidation(res.validation);
    } catch (err) {
      alert(`エラー: ${err instanceof Error ? err.message : "不明"}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (!theme.trim() || loading) return;
    setLoading(true);
    setBuildResult("");
    try {
      const res = await apiPost<{
        entries: Array<{ name: string; count: number }>;
        strategy: string;
        weaknesses: string[];
      }>("/api/deck/build", { theme, format });
      const deckText = res.entries
        .map((e) => `${e.count} ${e.name}`)
        .join("\n");
      setBuildResult(
        `${res.strategy}\n\n--- デッキリスト ---\n${deckText}\n\n弱点: ${res.weaknesses.join(", ") || "なし"}`
      );
      setDecklist(deckText);
    } catch (err) {
      setBuildResult(
        `エラー: ${err instanceof Error ? err.message : "不明"}`
      );
    } finally {
      setLoading(false);
    }
  }

  const totalCards = score
    ? Object.values(score.civilizationBalance).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-8 py-6 border-b border-border-highlight bg-bg-surface/50 backdrop-blur-sm flex justify-between items-end">
        <div>
          <div className="flex items-center gap-2 text-text-muted text-sm mb-1">
            <span>Decks</span>
            <span className="material-symbols-outlined text-[14px]">
              chevron_right
            </span>
            <span className="text-white">デッキビルダー</span>
          </div>
          <h1 className="text-3xl font-bold text-white">デッキ構築・評価</h1>
        </div>
        {/* Format Toggle */}
        <div className="flex gap-2">
          {(["original", "advance"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                format === f
                  ? "bg-primary/20 text-primary border border-primary/20"
                  : "bg-bg-surface-highlight text-text-muted hover:text-white border border-border-subtle"
              }`}
            >
              {f === "original" ? "Original" : "Advance"}
            </button>
          ))}
        </div>
      </div>

      {/* Dashboard Columns */}
      <div className="flex-1 overflow-hidden p-6 grid grid-cols-12 gap-6">
        {/* Left Column: Deck Input */}
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-6 overflow-y-auto pr-2">
          {/* Deck List Input */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider">
                Deck List
              </h3>
              <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded">
                40 Cards
              </span>
            </div>
            <form onSubmit={handleEvaluate}>
              <textarea
                value={decklist}
                onChange={(e) => setDecklist(e.target.value)}
                className="w-full h-64 bg-bg-dark border border-border-highlight rounded-lg p-3 text-sm text-text-main font-mono focus:border-primary focus:ring-1 focus:ring-primary resize-none placeholder-text-dim/50"
                placeholder={`デッキリストを貼り付け...\n4 x ボルシャック・ドラゴン\n4 x ナチュラル・トラップ\n...`}
              />
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={loading || !decklist.trim()}
                  className="flex-1 py-2 bg-bg-surface-highlight hover:bg-bg-surface-highlight/80 text-white rounded-lg text-sm font-medium transition-colors flex justify-center items-center gap-2 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    analytics
                  </span>
                  評価する
                </button>
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={loading || !theme.trim()}
                  className="flex-1 py-2 bg-gradient-to-r from-primary to-cyan-400 hover:opacity-90 text-bg-dark rounded-lg text-sm font-bold transition-opacity shadow-lg shadow-primary/10 flex justify-center items-center gap-2 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    auto_fix_high
                  </span>
                  Auto Build
                </button>
              </div>
            </form>
          </div>

          {/* Theme Input for Auto Build */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
            <h3 className="text-sm font-semibold text-text-muted mb-3">
              Auto Build テーマ
            </h3>
            <input
              type="text"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="例: ボルシャック, 5cコントロール"
              className="w-full bg-bg-dark border border-border-highlight rounded-lg px-3 py-2 text-sm text-text-main focus:border-primary focus:ring-1 focus:ring-primary placeholder-text-dim/50"
            />
          </div>

          {/* AI Suggestion */}
          {score && score.suggestions.length > 0 && (
            <div className="bg-bg-surface border border-border-highlight rounded-xl p-5 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-6xl text-primary">
                  lightbulb
                </span>
              </div>
              <h3 className="text-sm font-semibold text-white mb-2 relative z-10">
                AI Suggestion
              </h3>
              <p className="text-xs text-text-muted leading-relaxed relative z-10">
                {score.suggestions[0]}
              </p>
            </div>
          )}

          {/* My Decks (ログイン時のみ) */}
          {loggedIn && (
            <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
              <h3 className="text-sm font-semibold text-text-muted mb-3">
                マイデッキ
              </h3>
              {myDecks.length === 0 ? (
                <p className="text-xs text-text-dim">
                  保存したデッキはありません
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {myDecks.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between gap-2 bg-bg-dark rounded-lg px-3 py-2"
                    >
                      <button
                        onClick={() => loadDeck(d.id)}
                        className="flex flex-col items-start min-w-0 flex-1 text-left"
                      >
                        <span className="text-xs text-white truncate w-full">
                          {d.title}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          {d.format} · {d.overall ?? "--"}点
                        </span>
                      </button>
                      <button
                        onClick={() => deleteDeck(d.id)}
                        className="text-text-dim hover:text-dm-fire transition-colors flex-shrink-0"
                        title="削除"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          delete
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Center Column: Build Result / Validation */}
        <div className="col-span-12 lg:col-span-6 flex flex-col bg-bg-surface border border-border-highlight rounded-xl overflow-hidden">
          <div className="p-4 border-b border-border-highlight flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-text-muted">
              {buildResult ? "構築結果" : "デッキ内容"}
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {buildResult ? (
              <pre className="whitespace-pre-wrap font-mono text-sm text-text-muted leading-relaxed">
                {buildResult}
              </pre>
            ) : validation && !validation.valid ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-dm-fire/30 bg-dm-fire/10 p-4">
                  <h4 className="text-sm font-medium text-dm-fire mb-2">
                    レギュレーション違反
                  </h4>
                  <ul className="space-y-1">
                    {validation.errors.map((e, i) => (
                      <li key={i} className="text-sm text-text-muted">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
                {validation.warnings.length > 0 && (
                  <div className="rounded-xl border border-dm-light/30 bg-dm-light/10 p-4">
                    <h4 className="text-sm font-medium text-dm-light mb-2">
                      警告
                    </h4>
                    <ul className="space-y-1">
                      {validation.warnings.map((w, i) => (
                        <li key={i} className="text-sm text-text-muted">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : score ? (
              <div className="space-y-4">
                {score.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-lg bg-dm-fire/10 border border-dm-fire/20 text-sm text-text-muted"
                  >
                    {w}
                  </div>
                ))}
                {score.suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-lg bg-primary/10 border border-primary/20 text-sm text-text-muted"
                  >
                    {s}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-text-dim">
                <div className="text-center">
                  <span className="material-symbols-outlined text-5xl mb-4 block opacity-30">
                    style
                  </span>
                  <p className="text-sm">
                    デッキリストを入力して評価するか、テーマを指定して自動構築してください
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Analytics */}
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-6 overflow-y-auto pl-2">
          {/* Overall Score */}
          <div className="bg-gradient-to-br from-bg-surface to-bg-surface-highlight border border-border-highlight rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none" />
            <h3 className="text-sm font-semibold text-text-muted mb-4">
              Deck Power Score
            </h3>
            <div className="flex items-end gap-3">
              <span className="text-5xl font-bold text-white tracking-tighter">
                {score ? scoreGrade(score.overall) : "--"}
              </span>
              <div className="mb-1.5">
                <div className="text-xs text-primary font-bold uppercase tracking-wider">
                  {score ? `${score.overall}/100` : "未評価"}
                </div>
                <div className="text-[10px] text-text-muted">
                  初動率:{" "}
                  {score
                    ? `${Math.round(score.openingHandRate * 100)}%`
                    : "--"}
                </div>
              </div>
            </div>
          </div>

          {/* Mana Curve */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-muted mb-6">
              Mana Curve
            </h3>
            <div className="h-32 flex items-end justify-between gap-2 px-1">
              {[
                {
                  label: "低",
                  value: score?.costCurve.low ?? 0,
                  max: 20,
                },
                {
                  label: "中",
                  value: score?.costCurve.mid ?? 0,
                  max: 20,
                },
                {
                  label: "高",
                  value: score?.costCurve.high ?? 0,
                  max: 20,
                },
              ].map((bar) => (
                <div
                  key={bar.label}
                  className="flex flex-col items-center gap-1 group w-full"
                >
                  <div className="w-full bg-bg-surface-highlight rounded-t-sm relative h-24 group-hover:bg-bg-surface-highlight/80 transition-colors">
                    <div
                      className="absolute bottom-0 w-full bg-primary rounded-t-sm transition-all"
                      style={{
                        height: `${Math.min((bar.value / bar.max) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-text-muted font-medium">
                    {bar.label} ({bar.value})
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Civilization Ratio */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-muted mb-4">
              Civilization Ratio
            </h3>
            {score ? (
              <div className="flex items-center gap-4">
                {/* Donut placeholder */}
                <div className="relative w-24 h-24 rounded-full border-4 border-bg-surface-highlight flex items-center justify-center shrink-0">
                  <svg
                    className="w-full h-full -rotate-90"
                    viewBox="0 0 36 36"
                  >
                    {Object.entries(score.civilizationBalance).reduce<
                      { el: React.ReactNode[]; offset: number }
                    >(
                      (acc, [civ, count]) => {
                        const pct = totalCards
                          ? (count / totalCards) * 100
                          : 0;
                        acc.el.push(
                          <circle
                            key={civ}
                            cx="18"
                            cy="18"
                            r="15.9155"
                            fill="none"
                            stroke={CIV_HEX[civ] ?? "#6b7280"}
                            strokeWidth="3"
                            strokeDasharray={`${pct} ${100 - pct}`}
                            strokeDashoffset={`${-acc.offset}`}
                          />
                        );
                        acc.offset += pct;
                        return acc;
                      },
                      { el: [], offset: 0 }
                    ).el}
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center flex-col">
                    <span className="text-xs font-bold text-white">
                      {Object.keys(score.civilizationBalance).length}
                    </span>
                    <span className="text-[8px] text-text-muted">Civs</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 w-full">
                  {Object.entries(score.civilizationBalance).map(
                    ([civ, count]) => (
                      <div
                        key={civ}
                        className="flex justify-between items-center text-xs"
                      >
                        <span className="flex items-center gap-1.5 text-text-muted">
                          <span
                            className={`w-2 h-2 rounded-full ${CIV_COLORS[civ]?.dot ?? "bg-gray-500"}`}
                          />
                          {CIV_LABELS[civ] ?? civ}
                        </span>
                        <span className="font-medium text-white">
                          {totalCards
                            ? Math.round((count / totalCards) * 100)
                            : 0}
                          %
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-text-dim">デッキ評価後に表示されます</p>
            )}
          </div>

          {/* Shield Triggers */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-sm font-semibold text-text-muted">
                Shield Triggers
              </h3>
              <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {score?.triggerCount ?? 0} Cards
              </span>
            </div>
            <div className="relative pt-1">
              <div className="overflow-hidden h-2 mb-2 text-xs flex rounded bg-bg-surface-highlight">
                <div
                  className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-dm-light"
                  style={{
                    width: `${Math.min(((score?.triggerCount ?? 0) / 20) * 100, 100)}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-text-muted font-medium">
                <span>0</span>
                <span>Low</span>
                <span className="text-dm-light">Avg (8)</span>
                <span>High</span>
                <span>20</span>
              </div>
            </div>
          </div>

          {/* デッキ保存 (評価後のみ表示) */}
          {score && (
            <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-muted mb-3">
                デッキを保存
              </h3>
              {loggedIn ? (
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={100}
                    placeholder="デッキ名"
                    className="w-full bg-bg-dark border border-border-highlight rounded-lg px-3 py-2 text-sm text-text-main placeholder-text-dim/50 focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={handleSave}
                    disabled={!title.trim()}
                    className="py-2 bg-primary/20 text-primary rounded-lg text-sm font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
                  >
                    保存
                  </button>
                  {saveMsg && (
                    <p className="text-xs text-text-muted">{saveMsg}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-text-dim">
                  ログインすると保存できます
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
