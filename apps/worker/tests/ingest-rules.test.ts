import { describe, it, expect } from "vitest";
// 副作用の無いモジュールから import する。ingest-rules.js 経由だと pdf-parse を
// 引きずり込んでしまう (ESM 経由だとデバッグ経路でテスト用 PDF を同期読みしうる)。
import { findRulesPdfUrl, extractVersion } from "../src/rules-pdf.js";

// 実際のルール改訂ページ (/rule/rulechange/) には総合ルール以外の PDF も並ぶ。
const RULE_CHANGE_HTML = `
  <a href="/img/dhueparty_rule_20251217.pdf">デュエパーティー</a>
  <a href="/img/dm_competition_rule_20250501.pdf">競技ルール</a>
  <a href="/img/dm_rule_20260410_4.pdf">総合ゲームルール</a>
`;

describe("findRulesPdfUrl", () => {
  it("競技ルール/デュエパーティーではなく総合ゲームルールの PDF を選ぶ", () => {
    expect(findRulesPdfUrl(RULE_CHANGE_HTML, "https://dm.example")).toBe(
      "https://dm.example/img/dm_rule_20260410_4.pdf",
    );
  });

  it("複数バージョンがあれば日付が最も新しいものを選ぶ", () => {
    const html = `
      <a href="/img/dm_rule_20260213_2.pdf">旧</a>
      <a href="/img/dm_rule_20260410_4.pdf">新</a>
      <a href="/img/dm_rule_20251101.pdf">もっと旧</a>`;
    expect(findRulesPdfUrl(html, "https://dm.example")).toBe(
      "https://dm.example/img/dm_rule_20260410_4.pdf",
    );
  });

  it("絶対 URL はそのまま使う", () => {
    const html = `<a href="https://cdn.example/img/dm_rule_20260410_4.pdf">総合</a>`;
    expect(findRulesPdfUrl(html, "https://dm.example")).toBe(
      "https://cdn.example/img/dm_rule_20260410_4.pdf",
    );
  });

  it("総合ルールの PDF が無ければ null", () => {
    expect(findRulesPdfUrl(`<a href="/img/dm_competition_rule_20250501.pdf">競技</a>`)).toBeNull();
    expect(findRulesPdfUrl("<a href='/no-pdf'>x</a>")).toBeNull();
  });
});

describe("extractVersion", () => {
  it("本文の Ver. 表記からバージョンを取る", () => {
    expect(extractVersion("デュエル・マスターズ総合ゲームルール Ver.1.50\n最終更新日 ...")).toBe(
      "1.50",
    );
    expect(extractVersion("Ver. 1.49")).toBe("1.49");
  });

  it("見つからなければ unknown", () => {
    expect(extractVersion("バージョン表記なし")).toBe("unknown");
  });
});
