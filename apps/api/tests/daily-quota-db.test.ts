import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

/** 日次クォータのカウンタ (010_chat_daily_usage.sql) を実 Postgres で確かめる (F-1)。 */
describe.skipIf(!hasTestDb)("incrementChatUsage (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("同じユーザー・同じ日は 1, 2, 3 … と増え、日付・ユーザーが違えば別に数える", async () => {
    const { incrementChatUsage } = await import("../src/middleware/daily-quota.js");
    expect(await incrementChatUsage("discord:1", "2026-11-01")).toBe(1);
    expect(await incrementChatUsage("discord:1", "2026-11-01")).toBe(2);
    expect(await incrementChatUsage("discord:1", "2026-11-02")).toBe(1);
    expect(await incrementChatUsage("supabase:x", "2026-11-01")).toBe(1);
  });

  it("並行に呼んでも数え漏れない (UPSERT 1文)", async () => {
    const { incrementChatUsage } = await import("../src/middleware/daily-quota.js");
    await Promise.all(Array.from({ length: 20 }, () => incrementChatUsage("u:c", "2026-11-01")));
    const rows = await sql`SELECT count FROM chat_daily_usage WHERE user_id = 'u:c'`;
    expect(rows[0].count).toBe(20);
  });

  it("101回目で上限を超える (ミドルウェアは count > 100 で 429)", async () => {
    const { incrementChatUsage, DAILY_CHAT_LIMIT } =
      await import("../src/middleware/daily-quota.js");
    let n = 0;
    for (let i = 0; i <= DAILY_CHAT_LIMIT; i++) n = await incrementChatUsage("u:q", "2026-11-01");
    expect(n).toBe(DAILY_CHAT_LIMIT + 1);
  });
});
