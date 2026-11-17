import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, truncateAll } from "../../../tests/helpers/db.js";
import { getDb, runWithSql } from "../src/client.js";
import { userSettings } from "../src/schema.js";
import {
  classifyDbError,
  getSqlState,
  toDbErrorResponse,
  toSafeDbErrorLog,
} from "../src/errors.js";

// 実 DB が返す例外の形 (drizzle-orm 0.45.2 では cause.code に SQLSTATE) で分類を確かめる。
const MARKER = "SYNTH_MARKER_db_4b1e";

describe.skipIf(!hasTestDb)("DB 例外の正規化 (統合)", () => {
  const sql = getTestSql()!;
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error("例外が投げられなかった");
  }

  it("重複 INSERT の例外を 23505 / unique_violation と分類し、要約・応答にマーカーを出さない", async () => {
    const insert = () =>
      runWithSql(sql, () =>
        getDb().insert(userSettings).values({ user_id: MARKER, format: MARKER }),
      );
    await insert();
    const err = await captureError(insert);

    expect(getSqlState(err)).toBe("23505");
    expect(classifyDbError(err)).toBe("unique_violation");
    // 制約名 (内部スキーマ識別子) はログ要約に出さない。
    expect(JSON.stringify(toSafeDbErrorLog(err))).not.toContain("user_settings_pkey");
    expect(JSON.stringify(toSafeDbErrorLog(err))).not.toContain(MARKER);
    expect(toDbErrorResponse(err).status).toBe(409);
    expect(JSON.stringify(toDbErrorResponse(err))).not.toContain(MARKER);
  });

  it("23505 以外 (値長超過 22001) は unknown / 500 で、マーカーを出さない", async () => {
    const long = `${MARKER}${"x".repeat(200)}`;
    const err = await captureError(() =>
      runWithSql(sql, () => getDb().insert(userSettings).values({ user_id: long })),
    );

    expect(getSqlState(err)).toBe("22001");
    expect(classifyDbError(err)).toBe("unknown");
    expect(JSON.stringify(toSafeDbErrorLog(err))).not.toContain(MARKER);
    expect(toDbErrorResponse(err).status).toBe(500);
    expect(JSON.stringify(toDbErrorResponse(err))).not.toContain(MARKER);
  });
});
