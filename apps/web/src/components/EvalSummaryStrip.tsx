import type { Ref } from "react";
import { scoreGrade } from "@/lib/format";
import { validationErrorCount } from "@/lib/eval-result";
import type { DeckScore, ValidationResult } from "@/lib/types";

/**
 * デッキ評価結果のサマリーストリップ (UI改善 P-3)。
 *
 * lg (1024px) 未満では 3 カラムが縦積みになり、スコアは入力欄と中央カラムのさらに下に出る。
 * 評価完了に気づけないので、入力カラムの直後に要点だけを出し、ここへスクロール+フォーカスする。
 * lg 以上は 3 カラムでスコアが元から見えているので `lg:hidden` (重複表示しない)。
 *
 * - `tabIndex={-1}`: プログラムからフォーカスを当てるため (Tab 順には入れない)
 * - `aria-live` は付けない: フォーカス移動で読まれるので、付けると二重に読み上げる
 * - 合否は色だけに頼らず文字 (OK / エラーN件) で出す
 */
export default function EvalSummaryStrip({
  score,
  validation,
  ref,
}: {
  score: DeckScore;
  validation: ValidationResult | null;
  ref?: Ref<HTMLElement>;
}) {
  const errors = validationErrorCount(validation);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby="eval-result-title"
      data-testid="eval-summary-strip"
      className="col-span-12 lg:hidden scroll-mt-2 rounded-xl border border-primary/30 bg-primary/10 p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <h2 id="eval-result-title" className="text-sm font-bold text-white">
        評価結果
      </h2>
      <dl className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-text-muted">
        <div className="flex items-baseline gap-2">
          <dt className="sr-only">ランク</dt>
          <dd className="text-3xl font-bold text-white">{scoreGrade(score.overall)}</dd>
          <dt className="sr-only">総合スコア</dt>
          <dd>
            <span className="text-lg font-bold text-white">{score.overall}</span> / 100
          </dd>
        </div>
        <div className="flex items-baseline gap-1">
          <dt>初動率</dt>
          <dd className="font-bold text-white">{Math.round(score.openingHandRate * 100)}%</dd>
        </div>
        <div className="flex items-baseline gap-1">
          <dt>トリガー</dt>
          <dd className="font-bold text-white">{score.triggerCount}</dd>
        </div>
        {validation && (
          <div className="flex items-baseline gap-1">
            <dt>殿堂チェック</dt>
            <dd className={`font-bold ${errors > 0 ? "text-danger" : "text-white"}`}>
              {errors > 0 ? `エラー${errors}件` : "OK"}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
