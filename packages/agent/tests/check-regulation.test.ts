import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { parseDecklist } from "@dm-ai/deck-engine";
import { getTestSql, hasTestDb, truncateAll, enableAppDb } from "../../../tests/helpers/db.js";
import {
  runTool,
  formatRegulationChecks,
  restrictedInDeckField,
  regulationUnavailableText,
  AGENT_TOOLS,
} from "../src/tools.js";
import { SYSTEM_PROMPTS } from "../src/prompts.js";

/** #178: 殿堂の単独質問を regulations で決定的に答える */

describe("formatRegulationChecks (単体)", () => {
  it("区分と枚数を1行ずつ出し、ツールの結果を優先させる一文を付ける", () => {
    const text = formatRegulationChecks(
      [
        {
          name: "ボルシャックドラゴン",
          status: "restricted",
          restriction: "殿堂入り",
          matchedName: "ボルシャック・ドラゴン",
        },
        {
          name: "ヘブンズ・ゲート",
          status: "restricted",
          restriction: "プレミアム殿堂",
          matchedName: "ヘブンズ・ゲート",
        },
        {
          name: "ボルメテウス・ホワイト・ドラゴン",
          status: "restricted",
          restriction: "プレミアム殿堂コンビ",
          matchedName: "ボルメテウス・ホワイト・ドラゴン",
        },
        { name: "スパイラル・ゲート", status: "unrestricted" },
      ],
      "original",
      "2026-11-01",
    );
    expect(text).toContain("フォーマット: オリジナル");
    expect(text).toContain("殿堂データ取込日: 2026-11-01");
    expect(text).toContain(
      "「ボルシャックドラゴン」: 殿堂入り (1枚まで) ※殿堂リスト上の表記《ボルシャック・ドラゴン》",
    );
    expect(text).toContain("「ヘブンズ・ゲート」: プレミアム殿堂 (デッキに入れられない)");
    expect(text).toContain("「ボルメテウス・ホワイト・ドラゴン」: プレミアム殿堂コンビ");
    expect(text).toContain("「スパイラル・ゲート」: 制限なし (4枚まで)");
    expect(text).toContain("この結果だけを根拠");
  });

  it("カード名を特定できないときは「制限なし」と書かず、候補を区分つきで出す", () => {
    const text = formatRegulationChecks(
      [
        {
          name: "ジョラゴン",
          status: "unknown_name",
          candidates: [{ name: "ジョラゴン・ビッグ1", restriction: "殿堂入り" }],
        },
      ],
      "original",
      null,
    );
    expect(text).toContain("特定できませんでした");
    expect(text).toContain("制限なしと断定しないでください");
    expect(text).toContain("《ジョラゴン・ビッグ1》[殿堂入り]");
    expect(text).not.toMatch(/「ジョラゴン」: 制限なし/);
  });
});

describe("restrictedInDeckField (単体)", () => {
  const regs = {
    ok: true as const,
    rows: [{ card_name: "ボルシャック・ドラゴン", restriction_type: "殿堂入り" }],
    fetchedAt: null,
  };

  it("殿堂入りを1枚だけ入れたデッキで列挙される", () => {
    const deck = parseDecklist("1 ボルシャック・ドラゴン\n4 青銅の鎧");
    expect(restrictedInDeckField(deck, regs)).toEqual([
      { name: "ボルシャック・ドラゴン", restriction: "殿堂入り", count: 1, limit: "1枚まで" },
    ]);
  });

  it("規制カードが無ければ「規制カードなし」", () => {
    const deck = parseDecklist("4 青銅の鎧");
    expect(restrictedInDeckField(deck, regs)).toBe("規制カードなし");
  });

  it("regulations を読めなければ「確認できなかった」", () => {
    const deck = parseDecklist("1 ボルシャック・ドラゴン");
    const r = restrictedInDeckField(deck, {
      ok: false,
      reason: "殿堂データベースに接続できませんでした",
    });
    expect(r).toContain("確認できなかった");
    expect(r).not.toBe("規制カードなし");
  });
});

describe("regulations 未接続 (単体, DATABASE_URL 空, #178 (e))", () => {
  it("check_regulation は「確認できませんでした」を返し、殿堂入りしていないと言わせない", async () => {
    const r = await runTool("check_regulation", { card_names: ["ジョラゴン"] });
    expect(r.text).toContain("確認できませんでした");
    expect(r.text).toContain("「殿堂入りしていない」");
    expect(r.text).toContain("書いてはいけません");
    expect(r.ok).toBe(false);
    expect(r.systemFailure).toBe(true);
  });

  it("regulationUnavailableText は対象の名前を全部出す", () => {
    const t = regulationUnavailableText(["A", "B"], "理由");
    expect(t).toContain("「A」「B」");
    expect(t).toContain("理由");
  });

  it("evaluate_deck の restricted_in_deck は「確認できなかった」になる", async () => {
    const r = await runTool("evaluate_deck", { decklist: "1 ボルシャック・ドラゴン\n4 青銅の鎧" });
    const json = JSON.parse(r.text) as { restricted_in_deck: unknown };
    expect(String(json.restricted_in_deck)).toContain("確認できなかった");
  });
});

describe("check_regulation 引数 (単体)", () => {
  it("card_names が無ければ引数エラー (システム障害ではない)", async () => {
    const r = await runTool("check_regulation", {});
    expect(r.text).toContain("ツール引数が不正です");
    expect(r.ok).toBe(false);
    expect(r.systemFailure).toBeFalsy();
  });

  it("空白だけの名前しか無ければ引数エラー", async () => {
    const r = await runTool("check_regulation", { card_names: ["  "] });
    expect(r.text).toContain("ツール引数が不正です");
  });

  it("モデルに渡すツール定義に check_regulation がある", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toContain("check_regulation");
  });
});

describe("プロンプト (#178 (d))", () => {
  it("deck / integrated は殿堂の根拠をツールの結果に限る", () => {
    for (const mode of ["deck", "integrated"] as const) {
      const p = SYSTEM_PROMPTS[mode];
      expect(p).toContain("check_regulation");
      expect(p).toContain("結果だけを根拠");
      expect(p).toContain("記憶と食い違う場合はツールの結果を優先");
      expect(p).toContain("結果に無いカードを殿堂だと書いてはいけません");
    }
  });
});

describe.skipIf(!hasTestDb)("殿堂の区分 (統合, #178)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const card = (name: string, cost: number) =>
      sql`INSERT INTO cards (name, civilizations, cost, type, races, text, official_id)
          VALUES (${name}, ${sql.json(["fire"])}, ${cost}, 'creature', ${sql.json([])}, '', ${name})`;
    await card("ボルシャック・ドラゴン", 6);
    await card("ジョラゴン・ビッグ1", 8);
    await card("スパイラル・ゲート", 2);
    await card("龍装艦 チェンジザ / 六奇怪の四", 6);
    const reg = (name: string, type: string, format = "original") =>
      sql`INSERT INTO regulations (format, restriction_type, card_name, effective_from)
          VALUES (${format}, ${type}, ${name}, '2026-10-01')`;
    await reg("ボルシャック・ドラゴン", "殿堂入り");
    await reg("ジョラゴン・ビッグ1", "殿堂入り");
    await reg("ヘブンズ・ゲート", "プレミアム殿堂");
    await reg("龍装艦 チェンジザ / 六奇怪の四", "殿堂入り");
    await reg("ボルメテウス・ホワイト・ドラゴン", "プレミアム殿堂コンビ");
  });

  it("check_regulation: 殿堂入り / プレミアム殿堂 / コンビ / 制限なし", async () => {
    const r = await runTool("check_regulation", {
      card_names: [
        "ボルシャックドラゴン",
        "ﾍﾌﾞﾝｽﾞ･ｹﾞｰﾄ",
        "ボルメテウス・ホワイト・ドラゴン",
        "スパイラル・ゲート",
        "龍装艦 チェンジザ",
      ],
    });
    expect(r.ok).not.toBe(false);
    expect(r.text).toContain("「ボルシャックドラゴン」: 殿堂入り (1枚まで)");
    expect(r.text).toContain("「ﾍﾌﾞﾝｽﾞ･ｹﾞｰﾄ」: プレミアム殿堂");
    expect(r.text).toContain("「ボルメテウス・ホワイト・ドラゴン」: プレミアム殿堂コンビ");
    expect(r.text).toContain("「スパイラル・ゲート」: 制限なし (4枚まで)");
    expect(r.text).toContain("「龍装艦 チェンジザ」: 殿堂入り");
    expect(r.text).toMatch(/殿堂データ取込日: \d{4}-\d{2}-\d{2}/);
  });

  it("check_regulation: 略称は制限なしにせず、cards から候補を区分つきで出す (No.33)", async () => {
    const r = await runTool("check_regulation", { card_names: ["ジョラゴン"] });
    expect(r.text).toContain("特定できませんでした");
    expect(r.text).toContain("《ジョラゴン・ビッグ1》[殿堂入り]");
  });

  it("check_regulation: フォーマットごとに引く (advance に行が無ければ確認できなかった)", async () => {
    const r = await runTool("check_regulation", {
      card_names: ["ボルシャック・ドラゴン"],
      format: "advance",
    });
    expect(r.text).toContain("確認できませんでした");
  });

  it("search_cards: 1行ごとに区分が付く", async () => {
    const r = await runTool("search_cards", { query: "ボルシャック" });
    expect(r.text).toContain("ボルシャック・ドラゴン [殿堂入り]");
    const r2 = await runTool("search_cards", { query: "スパイラル" });
    expect(r2.text).toContain("スパイラル・ゲート [制限なし]");
  });

  it("evaluate_deck: 殿堂入り1枚 (違反なし) でも restricted_in_deck に出る", async () => {
    const r = await runTool("evaluate_deck", {
      decklist: "1 ボルシャック・ドラゴン\n4 スパイラル・ゲート",
    });
    const json = JSON.parse(r.text) as { restricted_in_deck: unknown };
    expect(json.restricted_in_deck).toEqual([
      { name: "ボルシャック・ドラゴン", restriction: "殿堂入り", count: 1, limit: "1枚まで" },
    ]);
  });

  it("evaluate_deck: parseErrors と restricted_in_deck が同時に出る (#199, PR #182 の競合解消点)", async () => {
    // 読めない行 (数字だけの行) があっても restricted_in_deck を落とさず、parseErrors と並べて返す。
    // #165 B-06 (parseErrors) と #178 (c) (restricted_in_deck) が同じ out を組み立てているので、
    // どちらかのスプレッドで片方が消える退行をここで止める。
    const r = await runTool("evaluate_deck", {
      decklist: "1 ボルシャック・ドラゴン\n123\n4 スパイラル・ゲート",
    });
    const json = JSON.parse(r.text) as {
      restricted_in_deck: unknown;
      parseErrors?: string[];
      score: unknown;
      validation: unknown;
    };
    expect(json.restricted_in_deck).toEqual([
      { name: "ボルシャック・ドラゴン", restriction: "殿堂入り", count: 1, limit: "1枚まで" },
    ]);
    expect(json.parseErrors).toEqual(['パースできない行: "123"']);
    expect(json.score).toBeDefined();
    expect(json.validation).toBeDefined();
  });

  it("evaluate_deck: 規制カードが無ければ「規制カードなし」", async () => {
    const r = await runTool("evaluate_deck", { decklist: "4 スパイラル・ゲート" });
    const json = JSON.parse(r.text) as { restricted_in_deck: unknown };
    expect(json.restricted_in_deck).toBe("規制カードなし");
  });
});
