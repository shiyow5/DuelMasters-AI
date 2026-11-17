import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * agent のツール実行ログに err の中身を出さない (#311)。
 *
 * 対象は tools.ts の 2 箇所:
 * - findCardNamesLike (check_regulation の cards 参照) の catch
 * - runTool の全ツール共通 catch (DB / RAG / 外部 API の例外が入る)
 *
 * 秘密文字列を message / stack / cause に仕込んだ例外を投げさせ、console.error に渡された
 * 全引数に秘密が含まれないことと、toSafeErrorLog の要約 (event / errorId) が出ていることを固定する。
 * 呼び出し側の応答 (捏造させない文言・systemFailure) は変えない。
 */

const SECRETS = ["postgres://user:SECRET_PW@db.internal:5432", "sk-SECRET-TOKEN"];

function makeLeakyError(): Error {
  const cause = new Error(`cause ${SECRETS[1]}`);
  const err = new Error(`connect failed ${SECRETS[0]}`, { cause });
  err.stack = `Error: ${SECRETS[0]}\n    at ${SECRETS[1]}`;
  return err;
}

vi.mock("@dm-ai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/db")>();
  return {
    ...actual,
    getSql: () => {
      throw makeLeakyError();
    },
  };
});

// check_regulation で findCardNamesLike まで進めるため、regulations の読み込みだけ成功させる。
vi.mock("@dm-ai/deck-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/deck-engine")>();
  return {
    ...actual,
    loadRegulations: async () => ({
      ok: true,
      rows: [{ card_name: "ボルシャック・ドラゴン", restriction_type: "殿堂" }],
      fetchedAt: "2026-11-01",
    }),
  };
});

vi.mock("@dm-ai/rag", () => ({
  searchRules: async () => {
    throw makeLeakyError();
  },
}));

const { runTool } = await import("../src/tools.js");

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map(
      (a) => (typeof a === "string" ? a : JSON.stringify(a)) + (a instanceof Error ? a.stack : ""),
    )
    .join("\n");
}

function expectSafe(spy: ReturnType<typeof vi.spyOn>) {
  expect(spy).toHaveBeenCalled();
  const text = logged(spy);
  for (const s of SECRETS) expect(text).not.toContain(s);
  expect(text).toContain('"event"');
  expect(text).toContain('"errorId"');
  expect(spy.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
}

describe("err 生ログを出さない (#311): agent tools", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("check_regulation: cards の参照失敗ログに秘密が出ない (判定は返る)", async () => {
    const out = await runTool("check_regulation", { card_names: ["ボルシャック・ドラゴン"] });
    expect(out.ok).not.toBe(false);
    expect(logged(errorSpy)).toContain("cards の参照に失敗");
    expectSafe(errorSpy);
  });

  it("runTool 共通 catch: ツール例外のログに秘密が出ない (捏造させない応答は従来どおり)", async () => {
    const out = await runTool("search_rules", { query: "ブロッカー" });
    expect(out.text).toContain("ツール search_rules の実行に失敗しました");
    expect(out.text).not.toContain(SECRETS[0]);
    const text = logged(errorSpy);
    expect(text).toContain("ツール実行エラー");
    expect(text).toContain('"tool":"search_rules"');
    expectSafe(errorSpy);
  });
});
