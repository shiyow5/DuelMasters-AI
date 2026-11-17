import { describe, it, expect } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { AGENT_TOOLS, runTool } from "../src/tools.js";

/**
 * zod スキーマが LangChain → Gemini に「正しく渡る」ことの回帰テスト (Issue #297 PR-2 / テスト観点 6)。
 *
 * zod 3→4 移行で schema の変換結果や parse 失敗時の挙動が静かに変わっていないかを検出するため、
 * 現行 (v3) の挙動を固定する。移行 PR でこのテストが落ちたら、差分が許容できるか (Gemini が受け付けるか)
 * を確認してから期待値を直すこと。
 *
 * 比較から外すキー (理由):
 * - `$schema`: v3 は draft-07、v4 は 2020-12 と値が変わる。Gemini 送信前に除去される。
 * - `additionalProperties`: Gemini 送信前に除去される (@langchain/google-genai 内部)。
 * - `maximum` (int のとき): v4 は `.int()` に Number.MAX_SAFE_INTEGER の maximum を付ける。
 *   意味は同じなので「無い or MAX_SAFE_INTEGER」を許容する。
 */

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  description?: string;
  [k: string]: unknown;
};

function schemaOf(name: string): JsonSchema {
  const t = AGENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return toJsonSchema((t as unknown as { schema: never }).schema) as JsonSchema;
}

const CIVS = ["fire", "water", "nature", "light", "darkness"];
const FORMATS = ["original", "advance"];

describe("AGENT_TOOLS の JSON Schema (LangChain toJsonSchema)", () => {
  it("tool 名の一覧と順序", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      "search_rules",
      "search_cards",
      "check_regulation",
      "evaluate_deck",
      "build_deck",
      "get_tier_list",
      "suggest_improvements",
    ]);
  });

  it("全 tool: トップは type=object、各 property に description が付く", () => {
    for (const t of AGENT_TOOLS) {
      const s = schemaOf(t.name);
      expect(s.type, t.name).toBe("object");
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        expect(typeof prop.description, `${t.name}.${key}`).toBe("string");
      }
    }
  });

  // [tool 名, properties の key→type, required]
  const SHAPES: Array<[string, Record<string, string>, string[]]> = [
    ["search_rules", { query: "string" }, ["query"]],
    [
      "search_cards",
      {
        query: "string",
        civilization: "string",
        min_cost: "number",
        max_cost: "number",
        type: "string",
      },
      [],
    ],
    ["check_regulation", { card_names: "array", format: "string" }, ["card_names"]],
    ["evaluate_deck", { decklist: "string", format: "string" }, ["decklist"]],
    [
      "build_deck",
      {
        theme: "string",
        format: "string",
        required_cards: "array",
        civilizations: "array",
        max_cost: "number",
        min_creatures: "integer",
      },
      ["theme"],
    ],
    ["get_tier_list", { format: "string", period: "string" }, []],
    ["suggest_improvements", { decklist: "string", goals: "array" }, ["decklist"]],
  ];

  it.each(SHAPES)("%s: properties の型と required", (name, types, required) => {
    const s = schemaOf(name);
    const actual = Object.fromEntries(
      Object.entries(s.properties ?? {}).map(([k, v]) => [k, v.type]),
    );
    expect(actual).toEqual(types);
    // required は無いとき省略される (v3) / 空配列 (他実装) のどちらでも同じ意味
    expect([...(s.required ?? [])].sort()).toEqual([...required].sort());
  });

  it("enum: 文明 / フォーマット / カード種別", () => {
    expect(schemaOf("search_cards").properties?.civilization?.enum).toEqual(CIVS);
    expect(schemaOf("search_cards").properties?.type?.enum).toEqual([
      "creature",
      "spell",
      "cross_gear",
      "castle",
      "weapon",
      "field",
      "tamaseed",
      "star_evolution_creature",
    ]);
    expect(schemaOf("build_deck").properties?.civilizations?.items?.enum).toEqual(CIVS);
    for (const name of ["check_regulation", "evaluate_deck", "build_deck", "get_tier_list"]) {
      expect(schemaOf(name).properties?.format?.enum, name).toEqual(FORMATS);
    }
  });

  it("配列の items: card_names / required_cards / goals は string", () => {
    expect(schemaOf("check_regulation").properties?.card_names?.items?.type).toBe("string");
    expect(schemaOf("build_deck").properties?.required_cards?.items?.type).toBe("string");
    expect(schemaOf("suggest_improvements").properties?.goals?.items?.type).toBe("string");
  });

  it("minimum / maximum: min_creatures は整数 minimum=1、他の number に境界は付かない", () => {
    const mc = schemaOf("build_deck").properties?.min_creatures;
    expect(mc?.type).toBe("integer");
    expect(mc?.minimum).toBe(1);
    // v3 は maximum 無し。v4 は Number.MAX_SAFE_INTEGER が付く (同義)。
    expect([undefined, Number.MAX_SAFE_INTEGER]).toContain(mc?.maximum);

    for (const [name, key] of [
      ["search_cards", "min_cost"],
      ["search_cards", "max_cost"],
      ["build_deck", "max_cost"],
    ] as const) {
      const p = schemaOf(name).properties?.[key];
      expect(p?.type, `${name}.${key}`).toBe("number");
      expect(p?.minimum, `${name}.${key}`).toBeUndefined();
      expect(p?.maximum, `${name}.${key}`).toBeUndefined();
    }
  });
});

describe("tool.invoke の不正引数 (LangChain が zod で検証)", () => {
  // 挙動の固定: LangChain の tool.invoke は不正な引数で **例外 (ToolInputParsingException)** を投げ、
  // func (= runTool) には到達しない。メッセージ全文は zod のバージョンで変わるので、
  // 固定するのは「例外であること」「LangChain 共通の接頭辞」「どの引数が悪いか」だけ。
  const PREFIX = "Received tool input did not match expected schema";

  async function invokeError(name: string, args: unknown): Promise<Error> {
    const t = AGENT_TOOLS.find((x) => x.name === name)!;
    try {
      await (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke(args);
    } catch (e) {
      return e as Error;
    }
    throw new Error(`${name} が例外を投げなかった`);
  }

  it.each<[string, string, unknown, string]>([
    ["必須欠落", "search_rules", {}, "query"],
    ["型違い (string に number)", "search_rules", { query: 1 }, "query"],
    ["型違い (number に string)", "search_cards", { min_cost: "a" }, "min_cost"],
    ["enum 外", "search_cards", { civilization: "purple" }, "civilization"],
    ["範囲外 (min_creatures=0)", "build_deck", { theme: "x", min_creatures: 0 }, "min_creatures"],
    [
      "小数 (min_creatures は整数)",
      "build_deck",
      { theme: "x", min_creatures: 1.5 },
      "min_creatures",
    ],
    ["配列要素の enum 外", "build_deck", { theme: "x", civilizations: ["火"] }, "civilizations"],
    ["配列に string", "check_regulation", { card_names: "x" }, "card_names"],
  ])("%s → 例外", async (_label, name, args, field) => {
    const err = await invokeError(name, args);
    expect(err.message).toContain(PREFIX);
    expect(err.message).toContain(field);
  });

  // 検証を通れば func (= runTool。例外は握って文字列で返す) に到達するので、invoke は string で解決する。
  it("正しい引数なら検証を通り、string で解決する", async () => {
    const t = AGENT_TOOLS.find((x) => x.name === "get_tier_list")!;
    const result = await (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke({
      format: "original",
    });
    expect(typeof result).toBe("string");
  });

  it("未知のキーは検証エラーにならない (zod 既定は strip)", async () => {
    const t = AGENT_TOOLS.find((x) => x.name === "get_tier_list")!;
    const result = await (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke({
      format: "original",
      unknown_key: 1,
    });
    expect(typeof result).toBe("string");
  });
});

describe("runTool の不正引数 (グラフの tools ノードは schema を通さず直接呼ぶ)", () => {
  // 例外ではなく {ok:false, text} を返す。システム障害 (systemFailure) ではないので、
  // モデルは引数を直して呼び直せる。zod のメッセージ本文は固定しない (v4 で変わる)。
  it.each<[string, Record<string, unknown>, string]>([
    ["build_deck", { theme: "x", min_creatures: 0 }, "min_creatures"],
    ["build_deck", { theme: "x", max_cost: "a" }, "max_cost"],
    ["build_deck", {}, "theme"],
    ["check_regulation", { card_names: "x" }, "card_names"],
  ])("%s %j → 'ツール引数が不正です: <引数名>' を返し throw しない", async (name, args, field) => {
    const r = await runTool(name, args);
    expect(r.ok).toBe(false);
    expect(r.systemFailure).toBeUndefined();
    expect(r.text).toContain(`ツール引数が不正です: ${field}`);
  });

  it("search_cards の不正 civilization は『検索条件が不正です』で、throw しない", async () => {
    const r = await runTool("search_cards", { query: "x", civilization: "purple" });
    expect(r.ok).toBe(false);
    expect(r.systemFailure).toBeUndefined();
    expect(r.text).toContain("検索条件が不正です");
  });

  it("未知のツール名は ok:false の『不明なツール』", async () => {
    const r = await runTool("nope", {});
    expect(r).toEqual({ text: "不明なツール: nope", ok: false });
  });
});
