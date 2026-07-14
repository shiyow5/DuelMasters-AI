import { describe, it, expect } from "vitest";
import { withToolFailureNotice } from "../src/interactions/run.js";

/**
 * Discord でもツール失敗を隠さない (#109)。
 *
 * 隠すと、データで裏付けられていない回答が「普通の回答」に見える。モデルは失敗したツールの
 * 穴を記憶で埋めるので、利用者はそれを信じてしまう (#112 で実際に起きた)。
 */
describe("withToolFailureNotice", () => {
  it("失敗が無ければ回答をそのまま返す", () => {
    expect(withToolFailureNotice({ response: "回答" })).toBe("回答");
    expect(withToolFailureNotice({ response: "回答", toolFailures: [] })).toBe("回答");
  });

  it("失敗したら警告を先頭に付ける (回答は消さない)", () => {
    const out = withToolFailureNotice({ response: "回答本文", toolFailures: ["search_cards"] });
    expect(out).toContain("カード検索に失敗しました");
    expect(out).toContain("裏付けられていません");
    // 回答自体は残す (利用者が読む価値がある場合もある。判断材料を与える)
    expect(out).toContain("回答本文");
    // 警告が先。回答を読んだ後に気づくのでは遅い。
    expect(out.indexOf("失敗")).toBeLessThan(out.indexOf("回答本文"));
  });

  it("同じツールが複数回失敗しても1つにまとめる", () => {
    const out = withToolFailureNotice({
      response: "x",
      toolFailures: ["search_cards", "search_cards"],
    });
    expect(out.match(/カード検索/g)).toHaveLength(1);
  });
});
