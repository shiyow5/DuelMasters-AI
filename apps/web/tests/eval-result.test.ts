import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EvalSummaryStrip from "../src/components/EvalSummaryStrip.js";
import {
  DESKTOP_MEDIA_QUERY,
  evalAnnouncement,
  resultScrollBehavior,
  validationErrorCount,
} from "../src/lib/eval-result.js";
import type { DeckScore, ValidationResult } from "../src/lib/types.js";

/** UI改善 P-3: 評価完了時のサマリーストリップと、スクロール/通知まわりの純粋関数 */

const score = (overrides: Partial<DeckScore> = {}): DeckScore => ({
  triggerCount: 12,
  rainbowCount: 0,
  costCurve: { low: 10, mid: 20, high: 10 },
  civilizationBalance: { fire: 20, nature: 20 },
  openingHandRate: 0.853,
  roleBalance: {},
  overall: 72,
  warnings: [],
  suggestions: [],
  ...overrides,
});

const valid: ValidationResult = { valid: true, errors: [], warnings: [] };
const invalid: ValidationResult = {
  valid: false,
  errors: ["殿堂カードが2枚", "40枚ではない"],
  warnings: [],
};

const render = (s: DeckScore, v: ValidationResult | null) =>
  renderToStaticMarkup(createElement(EvalSummaryStrip, { score: s, validation: v }));

describe("resultScrollBehavior", () => {
  it("reduce 指定時だけ瞬時 (auto)、それ以外は smooth", () => {
    expect(resultScrollBehavior(true)).toBe("auto");
    expect(resultScrollBehavior(false)).toBe("smooth");
  });
});

describe("DESKTOP_MEDIA_QUERY", () => {
  it("Tailwind の lg (1024px) と一致している (ストリップの lg:hidden と同じ境界)", () => {
    expect(DESKTOP_MEDIA_QUERY).toBe("(min-width: 1024px)");
  });
});

describe("validationErrorCount", () => {
  it("チェック結果なし / 通過は 0", () => {
    expect(validationErrorCount(null)).toBe(0);
    expect(validationErrorCount(valid)).toBe(0);
  });
  it("不通過はエラー件数", () => {
    expect(validationErrorCount(invalid)).toBe(2);
  });
});

describe("evalAnnouncement", () => {
  it("ランクと点数を読む", () => {
    expect(evalAnnouncement(score(), valid)).toBe("評価完了。ランクA、72点");
  });
  it("殿堂チェックのエラーがあれば件数も読む", () => {
    expect(evalAnnouncement(score({ overall: 55 }), invalid)).toBe(
      "評価完了。ランクC、55点、殿堂チェックのエラー2件",
    );
  });
});

describe("EvalSummaryStrip", () => {
  it("ランク・点数・初動率・トリガー・殿堂チェックを出す", () => {
    const html = render(score(), valid);
    expect(html).toContain(">評価結果</h2>");
    expect(html).toContain(">A</dd>");
    expect(html).toContain(">72</span> / 100");
    expect(html).toContain(">85%</dd>"); // 0.853 → 四捨五入
    expect(html).toContain(">12</dd>");
    expect(html).toContain(">OK</dd>");
  });

  it("フォーカス先にできて (tabIndex=-1)、見出しでラベル付けされ、lg 以上では隠れる", () => {
    const html = render(score(), valid);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-labelledby="eval-result-title"');
    expect(html).toContain('id="eval-result-title"');
    expect(html).toMatch(/class="[^"]*\blg:hidden\b/);
  });

  it("aria-live は付けない (フォーカス移動で読まれるので二重読み上げになる)", () => {
    expect(render(score(), valid)).not.toContain("aria-live");
  });

  it("殿堂チェック違反は色だけでなく文字で件数を出す", () => {
    const html = render(score(), invalid);
    expect(html).toContain("エラー2件");
    expect(html).toContain("text-red-400");
    expect(html).not.toContain(">OK</dd>");
  });

  it("チェック結果が無ければ殿堂チェック欄を出さない", () => {
    expect(render(score(), null)).not.toContain("殿堂チェック");
  });

  it("「NN/100」を連続した文字列にしない (右カラムの表記と重複させない)", () => {
    expect(render(score(), valid)).not.toContain("72/100");
  });
});
