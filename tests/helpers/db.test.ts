import { describe, it, expect } from "vitest";
import { getTestSql, hasTestDb } from "./db.js";

describe("テストDBハーネス", () => {
  it("TEST_DATABASE_URL の有無で getTestSql() の null/接続が切り替わる", () => {
    if (hasTestDb) {
      const sql = getTestSql();
      expect(sql).not.toBeNull();
    } else {
      expect(getTestSql()).toBeNull();
    }
  });

  it.skipIf(!hasTestDb)("接続して SELECT 1 が返る", async () => {
    const sql = getTestSql()!;
    const rows = await sql`SELECT 1 as one`;
    expect(Number(rows[0].one)).toBe(1);
    await sql.end();
  });
});
