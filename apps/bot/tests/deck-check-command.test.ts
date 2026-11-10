import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { handleCommand } from "../src/commands/index.js";

/**
 * `/殿堂チェック check` (slash コマンド経路) の title 判定 (#164 B-04)。
 *
 * DB 不通・regulations 0件などで殿堂判定をスキップした場合 (restrictionChecked=false) は
 * valid でも「OK」と出さず「未確認」を出すことを固定する。
 */

function makeInteraction(
  discordId: string,
  list: string,
): {
  interaction: ChatInputCommandInteraction;
  editReply: ReturnType<typeof vi.fn>;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    user: { id: discordId },
    options: {
      getSubcommandGroup: () => "deck",
      getSubcommand: () => "check",
      getString: (name: string) => (name === "list" ? list : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, editReply };
}

function stubApi(validation: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/api/user/settings")
        ? { format: "original" }
        : { score: {}, validation };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("/殿堂チェック check の title (#164 B-04)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("valid かつ restrictionChecked=false は「未確認」(OK と出さない)", async () => {
    stubApi({
      valid: true,
      errors: [],
      warnings: ["殿堂規制データを確認できませんでした"],
      restrictionChecked: false,
    });
    const { interaction, editReply } = makeInteraction("u1", "dummy");
    await handleCommand(interaction);
    const embed = editReply.mock.calls[0][0].embeds[0];
    const data = embed.data ?? embed.toJSON();
    expect(data.title).toBe("殿堂チェック: 未確認");
  });

  it("valid かつ restrictionChecked=true は「OK」", async () => {
    stubApi({ valid: true, errors: [], warnings: [], restrictionChecked: true });
    const { interaction, editReply } = makeInteraction("u2", "dummy");
    await handleCommand(interaction);
    const embed = editReply.mock.calls[0][0].embeds[0];
    const data = embed.data ?? embed.toJSON();
    expect(data.title).toBe("殿堂チェック: OK");
  });

  it("invalid は restrictionChecked の値に関わらず「NG」", async () => {
    stubApi({ valid: false, errors: ["4枚制限超過"], warnings: [], restrictionChecked: false });
    const { interaction, editReply } = makeInteraction("u3", "dummy");
    await handleCommand(interaction);
    const embed = editReply.mock.calls[0][0].embeds[0];
    const data = embed.data ?? embed.toJSON();
    expect(data.title).toBe("殿堂チェック: NG");
  });
});
