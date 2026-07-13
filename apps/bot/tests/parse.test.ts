import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/interactions/parse.js";
import { deckBuildEmbed, archetypeEmbed, ruleEmbed } from "../src/interactions/embeds.js";

/** `/dm rule question:...` の生ペイロード */
const RULE = {
  data: {
    name: "dm",
    options: [
      {
        name: "rule",
        type: 1,
        options: [{ name: "question", type: 3, value: "S・トリガーとは？" }],
      },
    ],
  },
};

/** `/dm deck rate list:...` (サブコマンドグループ) */
const DECK_RATE = {
  data: {
    name: "dm",
    options: [
      {
        name: "deck",
        type: 2,
        options: [{ name: "rate", type: 1, options: [{ name: "list", type: 3, value: "4 火1" }] }],
      },
    ],
  },
};

describe("parseCommand (生ペイロードの解釈)", () => {
  // Workers では discord.js の interaction.options.getSubcommand() が使えないため、
  // Discord が送る生の options ツリーを自前で辿る。
  it("サブコマンドとオプションを取り出す", () => {
    expect(parseCommand(RULE)).toEqual({
      group: undefined,
      sub: "rule",
      options: { question: "S・トリガーとは？" },
    });
  });

  it("サブコマンドグループ (type 2) を辿る", () => {
    expect(parseCommand(DECK_RATE)).toEqual({
      group: "deck",
      sub: "rate",
      options: { list: "4 火1" },
    });
  });

  it("オプションが無いサブコマンドも扱える", () => {
    const payload = { data: { name: "dm", options: [{ name: "ping", type: 1 }] } };
    expect(parseCommand(payload)).toEqual({ group: undefined, sub: "ping", options: {} });
  });

  it("options が無ければ null (不正なペイロードを握り潰さない)", () => {
    expect(parseCommand({ data: { name: "dm" } })).toBeNull();
    expect(parseCommand({})).toBeNull();
  });
});

describe("embed の文字数上限", () => {
  // Discord の embed title は 256 文字上限。超えると PATCH が拒否され、deferred のまま固まる。
  // theme / name はユーザー入力なので必ず切る。
  it("deckBuildEmbed のタイトルを 256 文字に収める", () => {
    const e = deckBuildEmbed("あ".repeat(500), [{ name: "火1", count: 4 }]);
    expect(e.title!.length).toBeLessThanOrEqual(256);
  });

  it("archetypeEmbed のタイトルを 256 文字に収める", () => {
    const e = archetypeEmbed("あ".repeat(500), null);
    expect(e.title!.length).toBeLessThanOrEqual(256);
  });

  it("ruleEmbed の description は 4000 文字に収める", () => {
    const e = ruleEmbed("あ".repeat(9000));
    expect(e.description!.length).toBeLessThanOrEqual(4000);
  });
});
