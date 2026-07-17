"use client";

/**
 * CS 入賞デッキレシピの一覧 (#126)。
 *
 * **環境分析のティア表とは意図的に切り離してある。** 取込元 (デネブログ) は
 * フォーマット (オリジナル/アドバンス) を記録しておらず、デッキ名もティア表の
 * アーキタイプ名と 44.3% しか一致しない。ティア行に紐づけると、アドバンスのレシピを
 * オリジナルのデッキとして見せる等の誤りが起きるため、ここでは
 * **取込元が書いていることだけ**を出す。
 */
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

interface Recipe {
  source_url: string;
  posted_date: string;
  event_name: string;
  placement_label: string;
  deck_name: string;
  player: string | null;
  participants: number | null;
  decklist_image_url: string;
}

interface RecipeList {
  recipes: Recipe[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 24;

/** 順位の見た目。優勝だけ強調する。 */
function placementClass(label: string): string {
  if (label === "優勝") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (label === "準優勝") return "bg-slate-400/15 text-slate-300 border-slate-400/30";
  return "bg-bg-surface text-text-muted border-border-highlight";
}

export default function RecipesPage() {
  const [data, setData] = useState<RecipeList | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<Recipe | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      };
      if (search) params.q = search;
      setData(await apiGet<RecipeList>("/api/recipes", params));
    } catch (err) {
      setError(err instanceof Error ? err.message : "デッキレシピを取得できませんでした");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-text-main">CS入賞デッキレシピ</h1>
        <p className="text-sm text-text-muted mt-1">
          デネブログが公開している、CS の入賞デッキレシピ画像です。
        </p>
      </header>

      {/* 出せない情報を「無い」と明示する。#122 と同じ思想 (推測で埋めない)。 */}
      <p className="text-xs text-text-muted bg-bg-surface border border-border-highlight rounded-lg p-3 mb-4">
        取込元がフォーマット (オリジナル / アドバンス) を記載していないため、この一覧は
        フォーマットで絞り込めません。環境分析のティア表とも連動していません。
        デッキ名は取込元の表記のままです。
      </p>

      <form
        className="flex gap-2 mb-5"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setSearch(query.trim());
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="デッキ名・大会名で検索 (例: ウィリデ)"
          aria-label="デッキ名・大会名で検索"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg-surface border border-border-highlight text-text-main placeholder:text-text-muted"
        />
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-accent text-white font-medium shrink-0"
        >
          検索
        </button>
      </form>

      {loading && <p className="text-text-muted">読み込み中…</p>}
      {error && <p className="text-red-400">{error}</p>}

      {data && !loading && data.recipes.length === 0 && (
        <p className="text-text-muted">
          {search
            ? `「${search}」に一致するレシピはありません。`
            : "デッキレシピがまだありません。"}
        </p>
      )}

      {data && data.recipes.length > 0 && (
        <>
          <p className="text-sm text-text-muted mb-3">{data.total} 件</p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.recipes.map((r) => (
              <li
                key={r.source_url}
                className="bg-bg-surface border border-border-highlight rounded-xl overflow-hidden flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => setZoomed(r)}
                  aria-label={`${r.deck_name} のデッキリストを拡大`}
                  className="block w-full bg-black/20"
                >
                  {/* 外部 CDN (fc2) の画像。next/image の最適化は通さず素の img で出す。 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.decklist_image_url}
                    alt={`${r.deck_name} のデッキリスト`}
                    loading="lazy"
                    className="w-full h-48 object-cover"
                  />
                </button>
                <div className="p-3 flex flex-col gap-1.5 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-xs px-2 py-0.5 rounded border ${placementClass(r.placement_label)}`}
                    >
                      {r.placement_label}
                    </span>
                    <span className="text-xs text-text-muted">{r.posted_date} 掲載</span>
                  </div>
                  <h2 className="font-bold text-text-main break-words">{r.deck_name}</h2>
                  <p className="text-sm text-text-muted break-words">{r.event_name}</p>
                  <p className="text-xs text-text-muted break-words">
                    {r.player && <span>{r.player} さん</span>}
                    {r.participants !== null && <span> ・ {r.participants}人参加</span>}
                  </p>
                  <a
                    href={r.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline mt-auto pt-1"
                  >
                    デネブログの記事を開く
                  </a>
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-3 mt-6" aria-label="ページ送り">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg border border-border-highlight text-text-main disabled:opacity-40"
              >
                前へ
              </button>
              <span className="text-sm text-text-muted">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 rounded-lg border border-border-highlight text-text-main disabled:opacity-40"
              >
                次へ
              </button>
            </nav>
          )}
        </>
      )}

      {zoomed && <ZoomDialog recipe={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}

/**
 * レシピ画像の拡大。ネイティブ <dialog> + showModal() を使う
 * (トップレイヤ・背景 inert・フォーカス移動と復帰・Esc が標準で付く)。
 */
function ZoomDialog({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [downOnBackdrop, setDownOnBackdrop] = useState(false);

  useEffect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  }, [dialog]);

  return (
    <dialog
      ref={setDialog}
      aria-label={`${recipe.deck_name} のデッキリスト`}
      onClose={onClose}
      onMouseDown={(e) => setDownOnBackdrop(e.target === dialog)}
      // 押した位置を見ないと、画像内で選択を始めて外で離しただけで閉じてしまう
      onClick={(e) => {
        if (downOnBackdrop && e.target === dialog) dialog?.close();
      }}
      // Tailwind の preflight が `*,::backdrop{margin:0}` を当てて UA の
      // `dialog:modal{margin:auto}` を潰すため、m-auto で中央に戻す
      className="m-auto max-w-[95vw] max-h-[95vh] bg-transparent p-0 backdrop:bg-black/70"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-white font-bold break-words">{recipe.deck_name}</h2>
          {/* 必ずネイティブ close() を通す。React 側で unmount するとフォーカスが戻らない */}
          <button
            type="button"
            onClick={() => dialog?.close()}
            aria-label="閉じる"
            className="text-white/80 hover:text-white shrink-0"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={recipe.decklist_image_url}
          alt={`${recipe.deck_name} のデッキリスト`}
          className="max-w-[95vw] max-h-[85vh] object-contain rounded-lg"
        />
      </div>
    </dialog>
  );
}
