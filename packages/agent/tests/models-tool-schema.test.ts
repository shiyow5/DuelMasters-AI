import { describe, it, expect } from "vitest";
import { buildChatModel, configureAgent } from "../src/models.js";
import { AGENT_TOOLS } from "../src/tools.js";

/**
 * models.ts の buildChatModel → ChatGoogleGenerativeAI.bindTools(tools) に zod スキーマが渡り、
 * Gemini へ送る function declaration に変換される経路の回帰 (Issue #297 PR-2 / テスト観点 6)。
 *
 * **ネットワークは使わない**: ChatGoogleGenerativeAI は本物を使うが、bindTools は
 * 変換結果を bound config に持つだけで、API は invoke するまで呼ばれない。
 * (実 API は呼ばない。課金が発生するため。)
 *
 * zod 3→4 で変わりうる `$schema` / `additionalProperties` は Gemini 送信前に除去される。
 * ここでは「送信される形 (除去後)」を直接見るので、除去されていること自体も固定する。
 */

type Decl = {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; minimum?: number }>;
    required?: string[];
    [k: string]: unknown;
  };
};

function declarationsOf(chain: unknown): Decl[] {
  // 単一モデル → withFallbacks 無しの RunnableBinding。tools は config に入る。
  const cfg = (chain as { config?: { tools?: Array<{ functionDeclarations?: Decl[] }> } }).config;
  const decls = cfg?.tools?.[0]?.functionDeclarations;
  if (!decls)
    throw new Error("functionDeclarations が見つからない (bindTools の戻り構造が変わった?)");
  return decls;
}

describe("buildChatModel が Gemini へ渡す function declarations", () => {
  configureAgent({ apiKey: "dummy-not-used", chatModels: ["gemini-test-model"] });
  const decls = declarationsOf(buildChatModel(AGENT_TOOLS));
  const byName = (n: string) => decls.find((d) => d.name === n)!;

  it("全 tool が name / description 付きで、順序どおり渡る", () => {
    expect(decls.map((d) => d.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    for (const d of decls) expect(d.description.length, d.name).toBeGreaterThan(0);
  });

  it("parameters は type=object。$schema / additionalProperties は送られない", () => {
    for (const d of decls) {
      expect(d.parameters.type, d.name).toBe("object");
      expect(d.parameters, d.name).not.toHaveProperty("$schema");
      expect(d.parameters, d.name).not.toHaveProperty("additionalProperties");
    }
  });

  it("required / enum / minimum が zod から保たれて渡る", () => {
    expect(byName("search_rules").parameters.required).toEqual(["query"]);
    expect(byName("check_regulation").parameters.required).toEqual(["card_names"]);
    expect(byName("build_deck").parameters.required).toEqual(["theme"]);
    // query 任意 (「コスト7以上のクリーチャー」を表現するため必須にしない)
    expect(byName("search_cards").parameters.required ?? []).toEqual([]);

    expect(byName("search_cards").parameters.properties.civilization.enum).toEqual([
      "fire",
      "water",
      "nature",
      "light",
      "darkness",
    ]);
    expect(byName("evaluate_deck").parameters.properties.format.enum).toEqual([
      "original",
      "advance",
    ]);
    expect(byName("build_deck").parameters.properties.min_creatures.minimum).toBe(1);
  });

  it("Gemini が受け付けない exclusiveMinimum / exclusiveMaximum が含まれない", () => {
    expect(JSON.stringify(decls)).not.toMatch(/exclusive(Minimum|Maximum)/);
  });
});
