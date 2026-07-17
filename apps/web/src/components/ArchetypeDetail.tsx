"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { TierEntry } from "@/lib/types";

interface ArchetypeStats {
  total_entries: number;
  wins: number;
  top4: number;
  top8: number;
}

interface RecentResult {
  event_name: string;
  event_date: string;
  placement: number;
  participants: number | null;
  source_url: string | null;
  deck_archetype: string;
}

interface ArchetypeDetailResponse {
  archetype: string;
  format: string;
  stats: ArchetypeStats;
  recent_results: RecentResult[];
}

/**
 * アーキタイプの詳細 (環境分析でデッキをクリックしたとき)。
 *
 * 出せるのは**取込元に実在するデータだけ**:
 * 使用率・入賞数 (母数つき)・優勝/Top4/Top8・直近の大会結果 (出典リンク)・メインカード画像。
 *
 * **デッキのカード一覧は出さない。** アーキタイプ別のデッキリストは DB に無く
 * (`tournament_results` は順位しか持たない)、自動構築で作った"それっぽい"デッキを
 * 「このデッキの中身」として見せるのは**捏造**になる。実物のデッキリスト取込 (#126) が入るまで、
 * 無いことを画面上で正直に伝える。
 *
 * ## **ネイティブ `<dialog>` + `showModal()` を使う**
 *
 * 自前の `fixed inset-0` オーバーレイだと、モーダルの要件を手で実装することになり漏れる:
 * 開いたときにフォーカスを中へ移す / 背景を Tab で辿れなくする / 閉じたらトリガーへ戻す。
 * (レビュー指摘: 背景の DeckCard に「見えないのにフォーカスが当たる」状態になっていた)
 * `showModal()` は**トップレイヤ + inert な背景 + フォーカス移動/復帰 + Esc** を
 * ブラウザ標準で与えてくれる。手作りのフォーカストラップより確実。
 */
export default function ArchetypeDetail({
  entry,
  format,
  onClose,
}: {
  entry: TierEntry;
  format: "original" | "advance";
  onClose: () => void;
}) {
  const [data, setData] = useState<ArchetypeDetailResponse | null>(null);
  // モーダルは開くたびにマウントされるので、初期値を loading=true にしておく。
  // effect 内で同期 setState すると余計な再レンダーを誘発する (react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiGet<ArchetypeDetailResponse>(`/api/meta/archetype/${encodeURIComponent(entry.archetype)}`, {
      format,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError("");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "詳細を取得できませんでした");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.archetype, format]);

  const dialogRef = useRef<HTMLDialogElement>(null);

  // マウント時にモーダルとして開く (フォーカス移動・背景の inert 化はブラウザに任せる)。
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  /**
   * 背景を**押して離した**ときだけ閉じる。
   *
   * click は mousedown と mouseup で要素が違うと共通の祖先で発火する。押した位置を見ずに
   * 閉じると、モーダル内のテキストを選択しようとして外までドラッグしただけで閉じてしまい、
   * 選択も消える (レビュー指摘)。
   */
  const downOnBackdrop = useRef(false);

  /**
   * **閉じるときは必ずネイティブの close() を通す。**
   *
   * ここで onClose() を直に呼んで React に unmount させると、dialog が「閉じた」のではなく
   * 「DOM から消えた」ことになり、**ブラウザのフォーカス復帰が走らない** (トリガーに戻らない)。
   * close() → close イベント → 親が unmount、の順にする。
   */
  const closeDialog = () => dialogRef.current?.close();

  return (
    // ::backdrop がオーバーレイ。dialog 自身は中身の箱なので、背景クリックは target===dialog になる。
    <dialog
      ref={dialogRef}
      aria-label={`${entry.archetype} の詳細`}
      // Esc (cancel) も背景クリックも閉じるボタンも、すべてネイティブ close を経由して
      // ここに届く。フォーカス復帰はブラウザがやってくれる。
      onClose={onClose}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === dialogRef.current;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === dialogRef.current) closeDialog();
      }}
      className="w-full max-w-2xl bg-transparent p-0 text-text-main backdrop:bg-black/60"
    >
      <div className="max-h-[85vh] overflow-y-auto rounded-xl border border-border-highlight bg-bg-surface shadow-2xl">
        {/* ヘッダ */}
        <div className="flex items-start justify-between gap-4 border-b border-border-highlight p-4">
          <div className="min-w-0">
            <div className="mb-1 text-xs text-text-muted">
              {entry.tier} · {format === "original" ? "Original" : "Advance"}
            </div>
            <h2 className="truncate text-xl font-bold text-white">{entry.archetype}</h2>
          </div>
          <button
            onClick={closeDialog}
            aria-label="閉じる"
            className="flex-shrink-0 rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-surface-highlight hover:text-white"
          >
            {/* アイコンのリガチャ文字列が読み上げられないように隠す (名前は aria-label 側)。 */}
            <span aria-hidden="true" className="material-symbols-outlined">
              close
            </span>
          </button>
        </div>

        <div className="space-y-5 p-4">
          {/* メインカード + 使用率 */}
          <div className="flex gap-4">
            {entry.main_card ? (
              // eslint-disable-next-line @next/next/no-img-element -- 外部 CDN の画像 (公式サイト)
              <img
                src={entry.main_card.image_url}
                alt={entry.main_card.name}
                title={entry.main_card.name}
                loading="lazy"
                className="h-40 w-auto flex-shrink-0 rounded-lg border border-border-highlight object-contain"
              />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
              {entry.main_card && (
                <div>
                  <div className="text-xs text-text-muted">メインカード</div>
                  <div className="truncate text-sm text-white">{entry.main_card.name}</div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-text-muted">使用率</div>
                  <div className="text-lg font-bold text-primary">{entry.usage_rate}%</div>
                </div>
                <div>
                  <div className="text-xs text-text-muted">入賞数</div>
                  <div className="text-lg font-bold text-white">
                    {entry.entries}
                    <span className="text-xs font-normal text-text-muted">
                      /{entry.total_entries}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 戦績 */}
          {loading && <p className="text-sm text-text-dim">読み込み中...</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
          {data && (
            <>
              <div className="grid grid-cols-4 gap-2 rounded-lg bg-bg-dark p-3">
                {[
                  { label: "優勝", value: data.stats.wins },
                  { label: "Top4", value: data.stats.top4 },
                  { label: "Top8", value: data.stats.top8 },
                  { label: "記録数", value: data.stats.total_entries },
                ].map((s) => (
                  <div key={s.label} className="text-center">
                    <div className="text-xs text-text-muted">{s.label}</div>
                    <div className="text-lg font-bold text-white">{s.value}</div>
                  </div>
                ))}
              </div>

              {/* 直近の大会結果 */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-text-muted">直近の大会結果</h3>
                {data.recent_results.length === 0 ? (
                  <p className="text-sm text-text-dim">この期間の個別記録はありません</p>
                ) : (
                  <ul className="divide-y divide-border-highlight/50 overflow-hidden rounded-lg border border-border-highlight">
                    {data.recent_results.slice(0, 10).map((r, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between gap-3 bg-bg-dark px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-white">{r.event_name}</div>
                          <div className="text-xs text-text-muted">
                            {String(r.event_date).slice(0, 10)}
                            {r.participants ? ` · ${r.participants}人` : ""}
                            {/* ティア表の名前と個別記事の表記が違うことがあるので実際の表記も出す */}
                            {r.deck_archetype !== entry.archetype ? ` · ${r.deck_archetype}` : ""}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-bold ${
                              r.placement === 1
                                ? "bg-primary/20 text-primary"
                                : "bg-bg-surface-highlight text-text-muted"
                            }`}
                          >
                            {r.placement === 1 ? "優勝" : `${r.placement}位`}
                          </span>
                          {r.source_url && (
                            // **aria-label 必須**: アイコンフォントはリガチャなので、無いと
                            // スクリーンリーダーが中身の文字列 "open_in_new" をリンク名として
                            // 読み上げてしまう (title より要素のテキストが優先される)。
                            <a
                              href={r.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-text-dim transition-colors hover:text-white"
                              aria-label={`${r.event_name} の出典を開く`}
                              title="出典を開く"
                            >
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[16px]"
                              >
                                open_in_new
                              </span>
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {/*
            **無いものは「無い」と書く** (#109 と同じ思想)。
            黙って省くと「このデッキにはカード一覧が無い」ではなく「まだ実装されていない」ことが
            利用者に伝わらない。
          */}
          <div className="rounded-lg border border-border-highlight bg-bg-dark p-3">
            <h3 className="mb-1 text-sm font-semibold text-text-muted">デッキのカード一覧</h3>
            <p className="text-xs leading-relaxed text-text-dim">
              取込元 (大会結果の記事) には
              <strong className="text-text-muted">順位しか載っておらず</strong>
              、アーキタイプごとのデッキリストがまだありません。実物のデッキリストを取り込む対応が入るまでは
              表示できません。それらしいデッキを自動生成して「このデッキの中身」として出すことはしません。
            </p>
          </div>
        </div>
      </div>
    </dialog>
  );
}
