import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Discord ログイン失敗のログに err の中身を出さない (#311)。
 *
 * discord.js の例外 message / stack にはトークン断片や接続情報が入りうる。秘密文字列を
 * message / stack / cause に仕込んだ例外で login を失敗させ、console.error に渡された全引数に
 * 秘密が含まれないことと、要約 (event / name / errorId) が出ていることを固定する。
 * 失敗時に process.exit(1) する挙動は変えない。
 */

const SECRETS = ["MTIzNDU2.SECRET-DISCORD-TOKEN", "wss://gateway.internal/SECRET"];

function makeLeakyError(): Error {
  const cause = new Error(`cause ${SECRETS[1]}`);
  const err = new Error(`An invalid token was provided: ${SECRETS[0]}`, { cause });
  err.name = "DiscordjsError";
  err.stack = `Error: ${SECRETS[0]}\n    at ${SECRETS[1]}`;
  return err;
}

vi.mock("discord.js", () => ({
  GatewayIntentBits: { Guilds: 1 },
  Events: { ClientReady: "ready", InteractionCreate: "interactionCreate" },
  Client: class {
    once() {}
    on() {}
    login() {
      return Promise.reject(makeLeakyError());
    }
  },
}));
vi.mock("../src/commands/index.js", () => ({ handleCommand: async () => {} }));

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map(
      (a) => (typeof a === "string" ? a : JSON.stringify(a)) + (a instanceof Error ? a.stack : ""),
    )
    .join("\n");
}

describe("err 生ログを出さない (#311): bot ログイン失敗", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("DISCORD_TOKEN", "dummy-token");
    vi.stubEnv("INTERNAL_API_KEY", "dummy-key");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("ログに秘密が出ず、種別名と errorId だけが出る (exit(1) は従来どおり)", async () => {
    await import("../src/index.js");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    const text = logged(errorSpy);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).toContain("Discord へのログインに失敗しました");
    expect(text).toContain('"event":"error"');
    expect(text).toContain('"name":"DiscordjsError"');
    expect(text).toContain('"errorId"');
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
  });
});
