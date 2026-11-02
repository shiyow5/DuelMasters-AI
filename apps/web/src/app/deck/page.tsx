"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiPost, apiGet, apiDelete } from "@/lib/api";
import { scoreGrade } from "@/lib/format";
import { savedCardsToDecklist, type SavedDeckCard } from "@/lib/deck-text";
import { supabase } from "@/lib/supabase";
import type { DeckScore, ValidationResult, SavedDeckSummary } from "@/lib/types";
import { CIV_COLORS, CIV_LABELS, CIV_HEX } from "@/lib/civ";
import Header from "@/components/Header";
import ErrorDisplay from "@/components/ErrorDisplay";
import DeckCardGrid from "@/components/DeckCardGrid";
import EvalSummaryStrip from "@/components/EvalSummaryStrip";
import {
  DESKTOP_MEDIA_QUERY,
  REDUCED_MOTION_MEDIA_QUERY,
  evalAnnouncement,
  resultScrollBehavior,
} from "@/lib/eval-result";

export default function DeckPage() {
  const [decklist, setDecklist] = useState("");
  const [theme, setTheme] = useState("");
  const [format, setFormat] = useState<"original" | "advance">("original");
  const [score, setScore] = useState<DeckScore | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [buildResult, setBuildResult] = useState<string>("");
  // デッキが持つカード (評価/読込/自動構築のたびにサーバのパース結果で更新する)。
  // カード画像グリッド (#129) の入力。
  const [deckEntries, setDeckEntries] = useState<Array<{ name: string; count: number }>>([]);
  // 中央カラムの表示切替: 内容(警告/構築結果) か カード画像グリッド か (#129)。
  const [centerView, setCenterView] = useState<"info" | "grid">("info");
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveOk, setSaveOk] = useState(false);
  const [myDecks, setMyDecks] = useState<SavedDeckSummary[]>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  // 読込/削除/評価/自動構築のエラーを画面内で統一表示する (alert は使わない)
  const [pageError, setPageError] = useState("");
  // 評価完了時に結果へ移動する (UI改善 P-3)。
  // サマリーストリップ (lg 未満のスクロール&フォーカス先) と pageError のラッパ。
  const resultRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // 評価が成功するたびに +1。`score` の変化で発火させると loadDeck (マイデッキ読込) でも
  // スクロールしてしまうので専用カウンタにする (loadDeck では増やさない: P-3-7 決定 1)。
  const [evalSeq, setEvalSeq] = useState(0);
  // デスクトップ幅用のスクリーンリーダー通知 (フォーカスを動かさない側)
  const [announce, setAnnounce] = useState("");

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

  // 評価成功 → lg 未満ならサマリーストリップへスクロールしてフォーカスを移す。
  // lg 以上は 3 カラムで結果が評価ボタンと同時に見えているので動かさない (announce で通知)。
  // effect は commit 後に走るので、同じバッチで描画されたストリップの DOM は既にある。
  useEffect(() => {
    if (evalSeq === 0) return; // 初期表示では動かない
    if (window.matchMedia(DESKTOP_MEDIA_QUERY).matches) return;
    const el = resultRef.current;
    if (!el) return;
    const reduce = window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches;
    // フォーカスは先に当て、スクロールは scrollIntoView に任せる (二重スクロール防止)
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: resultScrollBehavior(reduce), block: "start" });
  }, [evalSeq]);

  // エラーはコンテナ最上部に出る。lg 未満で評価ボタンまでスクロールしていると見えないので、
  // 見えていないときだけ可視域へ入れる (`nearest` = 既に見えていれば動かない)。
  // フォーカスは動かさない (role="alert" で読み上げられ、入力を続けられるように)。
  useEffect(() => {
    if (!pageError) return;
    const reduce = window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches;
    errorRef.current?.scrollIntoView({ behavior: resultScrollBehavior(reduce), block: "nearest" });
  }, [pageError]);

  async function handleSave() {
    if (!title.trim() || !score || saving) return;
    setSaveMsg("");
    setSaving(true);
    try {
      await apiPost("/api/deck/save", {
        title: title.trim(),
        format,
        decklist,
      });
      setSaveOk(true);
      setSaveMsg("保存しました");
      setTitle("");
      await refreshMyDecks();
    } catch (err) {
      setSaveOk(false);
      setSaveMsg(`保存に失敗しました: ${err instanceof Error ? err.message : "不明"}`);
    } finally {
      setSaving(false);
    }
  }

  async function loadDeck(id: number) {
    if (decklist.trim() && !confirm("現在の入力を破棄してこのデッキを読み込みますか?")) {
      return;
    }
    setPageError("");
    try {
      const deck = await apiGet<{
        // 超次元・GR の行は zone 付きで保存される (メインは zone 無し)。QA②
        cards: SavedDeckCard[];
        format: "original" | "advance";
        // 保存時に計算・保存済みのスコア (#133)。GET /:id が返すので、
        // 読み込んだら再評価せずに即表示する (以前は捨てて「評価する」を押し直させていた)。
        scores: DeckScore | null;
      }>(`/api/deck/${id}`);
      setDecklist(savedCardsToDecklist(deck.cards));
      setFormat(deck.format);
      setScore(deck.scores ?? null);
      // グリッドは評価時と同じくメインデッキだけ
      setDeckEntries(deck.cards.filter((c) => !c.zone));
      // 殿堂チェック (validation) は保存していないので復元しない。スコアだけ即表示する。
      setValidation(null);
      setBuildResult("");
    } catch (err) {
      setPageError(`読み込みに失敗しました: ${err instanceof Error ? err.message : "不明"}`);
    }
  }

  async function deleteDeck(id: number) {
    if (!confirm("このデッキを削除しますか?")) return;
    setPageError("");
    try {
      await apiDelete(`/api/deck/${id}`);
      await refreshMyDecks();
    } catch (err) {
      setPageError(`削除に失敗しました: ${err instanceof Error ? err.message : "不明"}`);
    }
  }

  async function handleEvaluate(e: React.FormEvent) {
    e.preventDefault();
    if (!decklist.trim() || loading) return;
    setLoading(true);
    setPageError("");
    setScore(null);
    setValidation(null);
    // 連続評価で同じ文面でも読み上げ直されるよう、いったん空にする
    setAnnounce("");
    // 評価開始時に前回のカードグリッドも消す。ここで消さないと、評価が失敗したとき
    // (セッション切れ/500/通信断) に前のデッキのカード画像が新しい入力の隣に残る (Codex P2)。
    setDeckEntries([]);
    try {
      const res = await apiPost<{
        parsed: { entries: Array<{ name: string; count: number }> };
        score: DeckScore;
        validation: ValidationResult;
      }>("/api/deck/evaluate", { decklist, format });
      setScore(res.score);
      setValidation(res.validation);
      setDeckEntries(res.parsed.entries);
      // 成功時のみ。失敗 (catch) では結果へ移動しない
      setEvalSeq((n) => n + 1);
      if (window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
        setAnnounce(evalAnnouncement(res.score, res.validation));
      }
    } catch (err) {
      setPageError(`評価に失敗しました: ${err instanceof Error ? err.message : "不明"}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (!theme.trim() || loading) return;
    if (decklist.trim() && !confirm("現在の入力を破棄して自動構築の結果に置き換えますか?")) {
      return;
    }
    setLoading(true);
    setPageError("");
    setBuildResult("");
    try {
      const res = await apiPost<{
        entries: Array<{ name: string; count: number }>;
        strategy: string;
        weaknesses: string[];
      }>("/api/deck/build", { theme, format });
      const deckText = res.entries.map((e) => `${e.count} ${e.name}`).join("\n");
      setBuildResult(
        `${res.strategy}\n\n--- デッキリスト ---\n${deckText}\n\n弱点: ${res.weaknesses.join(", ") || "なし"}`,
      );
      setDecklist(deckText);
      setDeckEntries(res.entries);
    } catch (err) {
      setPageError(`自動構築に失敗しました: ${err instanceof Error ? err.message : "不明"}`);
    } finally {
      setLoading(false);
    }
  }

  const totalCards = score
    ? Object.values(score.civilizationBalance).reduce((a, b) => a + b, 0)
    : 0;

  // 入力中デッキリストの合計枚数 (各行の先頭数値を合算)
  const parsedCount = decklist.split("\n").reduce((s, l) => {
    const m = l.trim().match(/^(\d+)/);
    return s + (m ? parseInt(m[1], 10) : 0);
  }, 0);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <Header
        left={
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-text-muted text-sm mb-1 max-sm:hidden">
              <span>Decks</span>
              <span className="material-symbols-outlined text-[14px]">chevron_right</span>
              <span className="text-white">デッキビルダー</span>
            </div>
            <h1 className="text-xl sm:text-3xl font-bold text-white truncate">デッキ構築・評価</h1>
          </div>
        }
        right={
          <div className="flex gap-2">
            {(["original", "advance"] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFormat(f);
                  setScore(null);
                  setValidation(null);
                }}
                className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  format === f
                    ? "bg-primary/20 text-primary border border-primary/20"
                    : "bg-bg-surface-highlight text-text-muted hover:text-white border border-border-subtle"
                }`}
              >
                {f === "original" ? "Original" : "Advance"}
              </button>
            ))}
          </div>
        }
      />

      {/* Dashboard Columns */}
      <div className="flex-1 overflow-y-auto lg:overflow-hidden p-6 grid grid-cols-12 gap-6">
        {/* デスクトップ幅の評価完了通知 (SR 用)。中身だけ差し替えるので常に描画しておく */}
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>

        {/* ページ全体のエラー (読込/削除/評価/自動構築) */}
        {pageError && (
          <div className="col-span-12" ref={errorRef}>
            <ErrorDisplay message={pageError} variant="error" onDismiss={() => setPageError("")} />
          </div>
        )}

        {/* Left Column: Deck Input */}
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-6 lg:overflow-y-auto lg:pr-2">
          {/* Deck List Input */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider">
                Deck List
              </h3>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  parsedCount === 40
                    ? "bg-primary/20 text-primary"
                    : "bg-bg-surface-highlight text-text-muted"
                }`}
              >
                {parsedCount}/40 枚
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
                  <span className="material-symbols-outlined text-[18px]">analytics</span>
                  評価する
                </button>
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={loading || !theme.trim()}
                  className="flex-1 py-2 bg-gradient-to-r from-primary to-primary-dark hover:opacity-90 text-bg-dark rounded-lg text-sm font-bold transition-opacity shadow-lg shadow-primary/10 flex justify-center items-center gap-2 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">auto_fix_high</span>
                  Auto Build
                </button>
              </div>
            </form>
          </div>

          {/* Theme Input for Auto Build */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
            <h3 className="text-sm font-semibold text-text-muted mb-3">Auto Build テーマ</h3>
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
                <span className="material-symbols-outlined text-6xl text-primary">lightbulb</span>
              </div>
              <h3 className="text-sm font-semibold text-white mb-2 relative z-10">AI Suggestion</h3>
              <p className="text-xs text-text-muted leading-relaxed relative z-10">
                {score.suggestions[0]}
              </p>
            </div>
          )}

          {/* My Decks (ログイン時のみ) */}
          {loggedIn && (
            <div className="bg-bg-surface border border-border-highlight rounded-xl p-4">
              <h3 className="text-sm font-semibold text-text-muted mb-3">マイデッキ</h3>
              {myDecks.length === 0 ? (
                <p className="text-xs text-text-dim">保存したデッキはありません</p>
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
                        <span className="text-xs text-white truncate w-full">{d.title}</span>
                        <span className="text-[10px] text-text-muted">
                          {d.format} · {d.overall ?? "--"}点
                        </span>
                      </button>
                      <button
                        onClick={() => deleteDeck(d.id)}
                        className="text-text-dim hover:text-danger transition-colors flex-shrink-0"
                        title="削除"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* 評価結果サマリー (lg 未満のみ。DOM 順: 入力 → ここ → 中央 → スコア) */}
        {score && <EvalSummaryStrip ref={resultRef} score={score} validation={validation} />}

        {/*
          Center Column: Build Result / Validation

          **overflow は lg 以上でだけ効かせる** (左右カラムの `lg:overflow-y-auto` と同じ方針)。
          lg 未満では 3カラムが縦積みになり、このカラムの高さはグリッド行の内容で決まる。
          そこで `overflow-hidden` と `flex-1`(basis 0) を無条件に付けると、**カラムが
          高さ2px(上下ボーダーのみ)に潰れたままヘッダをクリップ**し、ヘッダ内のトグルが
          「見えているのに押せない」状態になっていた (実測: 375/414/768/1000px で再現)。
        */}
        <div className="col-span-12 lg:col-span-6 flex flex-col bg-bg-surface border border-border-highlight rounded-xl lg:overflow-hidden">
          <div className="p-4 border-b border-border-highlight flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-text-muted">
              {centerView === "grid" ? "カード画像" : buildResult ? "構築結果" : "デッキ内容"}
            </h3>
            {/* 表示切替: 内容(警告/構築結果) ⇄ カード画像グリッド (#129) */}
            <div className="flex gap-1 rounded-lg bg-bg-dark p-0.5">
              {(
                [
                  { v: "info", label: "内容", icon: "description" },
                  { v: "grid", label: "画像", icon: "grid_view" },
                ] as const
              ).map(({ v, label, icon }) => (
                <button
                  key={v}
                  onClick={() => setCenterView(v)}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    centerView === v
                      ? "bg-bg-surface-highlight text-white"
                      : "text-text-muted hover:text-white"
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/*
            本文も lg 以上でだけスクロール枠にする。lg 未満で `flex-1`(basis 0) にすると
            カラムの内容高さに寄与せず、上記の潰れを招く。縦積み時はページ側がスクロールする。
          */}
          <div className="p-4 lg:flex-1 lg:overflow-y-auto">
            {/*
              グリッドは常にマウントしたまま CSS で表示を切り替える。ternary で unmount すると
              タブを切り替えるたびに再マウントされ、同じデッキで /api/card/resolve を無駄打ちして
              しまう (認証リクエストとレート制限を消費/ちらつき。Codex/サブエージェント指摘)。
            */}
            <div className={centerView === "grid" ? "" : "hidden"}>
              <DeckCardGrid entries={deckEntries} />
            </div>
            {centerView === "grid" ? null : buildResult ? (
              <pre className="whitespace-pre-wrap font-mono text-sm text-text-muted leading-relaxed">
                {buildResult}
              </pre>
            ) : validation && !validation.valid ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-danger/30 bg-danger/10 p-4">
                  <h4 className="text-sm font-medium text-danger mb-2">レギュレーション違反</h4>
                  <ul className="space-y-1">
                    {validation.errors.map((e, i) => (
                      <li key={i} className="text-sm text-text-muted">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
                {validation.warnings.length > 0 && (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
                    <h4 className="text-sm font-medium text-warning mb-2">警告</h4>
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
                {/*
                  レギュレーションの警告 (valid のまま評価を続けたもの。例: オリジナルに超次元・GR。QA②)。
                  以前は違反 (valid=false) のときしか出しておらず、評価が通ると警告が見えなかった。
                */}
                {validation?.warnings.map((w, i) => (
                  <div
                    key={`v${i}`}
                    className="p-3 rounded-lg bg-warning/10 border border-warning/30 text-sm text-text-muted"
                  >
                    {w}
                  </div>
                ))}
                {score.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-text-muted"
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
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-6 lg:overflow-y-auto lg:pl-2">
          {/* Overall Score */}
          <div className="bg-gradient-to-br from-bg-surface to-bg-surface-highlight border border-border-highlight rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none" />
            <h3 className="text-sm font-semibold text-text-muted mb-4">Deck Power Score</h3>
            <div className="flex items-end gap-3">
              <span className="text-5xl font-bold text-white tracking-tighter">
                {score ? scoreGrade(score.overall) : "--"}
              </span>
              <div className="mb-1.5">
                <div className="text-xs text-primary font-bold uppercase tracking-wider">
                  {score ? `${score.overall}/100` : "未評価"}
                </div>
                <div className="text-[10px] text-text-muted">
                  初動率: {score ? `${Math.round(score.openingHandRate * 100)}%` : "--"}
                </div>
              </div>
            </div>
          </div>

          {/* Mana Curve */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-muted mb-6">Mana Curve</h3>
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
                <div key={bar.label} className="flex flex-col items-center gap-1 group w-full">
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
            <h3 className="text-sm font-semibold text-text-muted mb-4">Civilization Ratio</h3>
            {score ? (
              <div className="flex items-center gap-4">
                {/* Donut placeholder */}
                <div className="relative w-24 h-24 rounded-full border-4 border-bg-surface-highlight flex items-center justify-center shrink-0">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                    {
                      Object.entries(score.civilizationBalance).reduce<{
                        el: React.ReactNode[];
                        offset: number;
                      }>(
                        (acc, [civ, count]) => {
                          const pct = totalCards ? (count / totalCards) * 100 : 0;
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
                            />,
                          );
                          acc.offset += pct;
                          return acc;
                        },
                        { el: [], offset: 0 },
                      ).el
                    }
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center flex-col">
                    <span className="text-xs font-bold text-white">
                      {Object.keys(score.civilizationBalance).length}
                    </span>
                    <span className="text-[8px] text-text-muted">Civs</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 w-full">
                  {Object.entries(score.civilizationBalance).map(([civ, count]) => (
                    <div key={civ} className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-text-muted">
                        <span
                          className={`w-2 h-2 rounded-full ${CIV_COLORS[civ]?.dot ?? "bg-gray-500"}`}
                        />
                        {CIV_LABELS[civ] ?? civ}
                      </span>
                      <span className="font-medium text-white">
                        {totalCards ? Math.round((count / totalCards) * 100) : 0}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-text-dim">デッキ評価後に表示されます</p>
            )}
          </div>

          {/* Shield Triggers */}
          <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-sm font-semibold text-text-muted">Shield Triggers</h3>
              <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {score?.triggerCount ?? 0} Cards
              </span>
            </div>
            <div className="relative pt-1">
              <div className="overflow-hidden h-2 mb-2 text-xs flex rounded bg-bg-surface-highlight">
                <div
                  className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-warning"
                  style={{
                    width: `${Math.min(((score?.triggerCount ?? 0) / 20) * 100, 100)}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-text-muted font-medium">
                <span>0</span>
                <span>Low</span>
                <span className="text-warning">Avg (8)</span>
                <span>High</span>
                <span>20</span>
              </div>
            </div>
          </div>

          {/* デッキ保存 (評価後のみ表示) */}
          {score && (
            <div className="bg-bg-surface border border-border-highlight rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-muted mb-3">デッキを保存</h3>
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
                    disabled={!title.trim() || saving}
                    className="py-2 bg-primary/20 text-primary rounded-lg text-sm font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                  {saveMsg && (
                    <ErrorDisplay message={saveMsg} variant={saveOk ? "success" : "error"} />
                  )}
                </div>
              ) : (
                <p className="text-xs text-text-dim">ログインすると保存できます</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
