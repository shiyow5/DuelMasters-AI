import { describe, it, expect } from "vitest";
import { toolLabel, toolSubject, phaseLabel, initialStatus } from "../src/lib/tools.js";

describe("toolSubject", () => {
  // 「ルールを検索しています」だけでは、**何を**調べているか分からない。
  // ツールごとに「見出しになる引数」が違うので、それを1つ選ぶ。
  it("検索系はクエリを出す", () => {
    expect(toolSubject("search_rules", { query: "S・トリガー 任意" })).toBe("S・トリガー 任意");
    expect(toolSubject("search_cards", { query: "ボルシャック" })).toBe("ボルシャック");
  });

  it("デッキ構築はテーマを出す", () => {
    expect(toolSubject("build_deck", { theme: "火文明の速攻", format: "original" })).toBe(
      "火文明の速攻",
    );
  });

  it("ティアはフォーマットを日本語にする", () => {
    expect(toolSubject("get_tier_list", { format: "original" })).toBe("オリジナル");
    expect(toolSubject("get_tier_list", { format: "advance" })).toBe("アドバンス");
  });

  it("デッキリストは長いので出さない", () => {
    // decklist は40行のテキスト。進行表示に流し込むと画面が壊れる。
    const decklist = Array.from({ length: 40 }, (_, i) => `4 カード${i}`).join("\n");
    expect(toolSubject("evaluate_deck", { decklist })).toBeNull();
    expect(toolSubject("suggest_improvements", { decklist })).toBeNull();
  });

  it("引数が無い・空なら null", () => {
    expect(toolSubject("search_rules", {})).toBeNull();
    expect(toolSubject("search_rules", { query: "" })).toBeNull();
    expect(toolSubject("search_rules", { query: "   " })).toBeNull();
    expect(toolSubject("unknown_tool", { query: "x" })).toBeNull();
  });

  it("長すぎるクエリは切り詰める (1行に収める)", () => {
    const long = "あ".repeat(100);
    const s = toolSubject("search_rules", { query: long });
    expect(s!.length).toBeLessThanOrEqual(41); // 40 + 省略記号
    expect(s!.endsWith("…")).toBe(true);
  });

  it("切り詰めでサロゲートペアを割らない", () => {
    // slice は UTF-16 コードユニット単位なので、絵文字を途中で割ると壊れた文字が出る。
    const s = toolSubject("search_rules", { query: "🔥".repeat(50) })!;
    expect(s).not.toContain("�"); // 置換文字 (壊れた文字) が出ていない
    expect(Array.from(s)).toHaveLength(41); // コードポイントで 40 + 省略記号
  });

  it("フォーマットの日本語化は format 引数のときだけ (検索クエリを化けさせない)", () => {
    // 「アドバンスのルールを知りたい」で query が "advance" 一語になることがある。
    // 全ツールに変換を当てると、実際に投げたクエリと表示が食い違う。
    expect(toolSubject("search_rules", { query: "advance" })).toBe("advance");
    expect(toolSubject("get_tier_list", { format: "advance" })).toBe("アドバンス");
  });

  it("改行は空白に潰す (進行表示が複数行にならないように)", () => {
    expect(toolSubject("search_rules", { query: "S・トリガー\nの任意性" })).toBe(
      "S・トリガー の任意性",
    );
  });
});

describe("toolLabel", () => {
  it("引数があれば「何を」まで出す", () => {
    expect(toolLabel("search_rules", { query: "S・トリガー" })).toBe(
      "ルールを検索しています: 「S・トリガー」",
    );
  });

  it("引数が無ければツール名の文言だけ", () => {
    expect(toolLabel("search_rules", {})).toBe("ルールを検索しています");
  });

  it("知らないツールは名前をそのまま出す (黙って壊れない)", () => {
    expect(toolLabel("brand_new_tool", {})).toBe("brand_new_tool");
  });
});

describe("phaseLabel", () => {
  // グラフのノードを通過した「あと」に updates が流れる。つまり phase は
  // 「いま何が終わったか」であり、画面には「次に何をしているか」を出す。
  it("retrieve の後は回答を考えている", () => {
    expect(phaseLabel("retrieve")).toBe("回答を考えています");
  });

  it("tools の後は結果を読んでいる", () => {
    expect(phaseLabel("tools")).toBe("検索結果を読んでいます");
  });

  it("agent と finalize は文言を変えない (直後にトークンが流れ始める)", () => {
    // ここで文言を出すと、回答が表示され始めた瞬間に進行表示が上書きされてちらつく。
    expect(phaseLabel("agent")).toBeNull();
    expect(phaseLabel("finalize")).toBeNull();
  });
});

describe("initialStatus", () => {
  // 最初のイベントが届くまで数秒かかる。三点リーダーだけだと何も起きていないように見える。
  it("rule モードは先に条文を探すので、そう表示する", () => {
    // グラフは rule のとき retrieve から始まる (state.mode === "rule" ? "retrieve" : "agent")。
    expect(initialStatus("rule")).toBe("関連する条文を探しています");
  });

  it("それ以外のモードは質問の読み取りから", () => {
    expect(initialStatus("integrated")).toBe("質問を読み取っています");
    expect(initialStatus("deck")).toBe("質問を読み取っています");
    expect(initialStatus("meta")).toBe("質問を読み取っています");
  });
});
