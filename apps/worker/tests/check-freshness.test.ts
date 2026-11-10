import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateFreshness,
  parseFreshnessArgs,
  describeRunError,
  jstDate,
  DEFAULT_THRESHOLDS,
  type FreshnessRows,
} from "../src/jobs/check-freshness.js";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

/** 火曜 12:00 JST (freshness.yml の schedule と同じ時刻) */
const TUE_NOON_JST = new Date("2026-11-03T03:00:00Z");

/** 両 format に同じ日付を入れた行 */
function rowsOf(weekly: string | null, snapshot: string | null, events: string | null) {
  const both = (latest: string | null) =>
    latest === null
      ? []
      : [
          { format: "original", latest },
          { format: "advance", latest },
        ];
  return { weekly: both(weekly), snapshot: both(snapshot), events: both(events) } as FreshnessRows;
}

describe("evaluateFreshness", () => {
  it("正常 (週次=2日前の日曜, snapshot=当日) → ok", () => {
    const r = evaluateFreshness(rowsOf("2026-11-01", "2026-11-03", "2026-11-01"), TUE_NOON_JST);
    expect(r.today).toBe("2026-11-03");
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("週次ランキングが10日前 → fail (format 名と日数がメッセージに出る)", () => {
    const rows = rowsOf("2026-11-01", "2026-11-03", "2026-11-01");
    rows.weekly = [
      { format: "original", latest: "2026-10-24" },
      { format: "advance", latest: "2026-11-01" },
    ];
    const r = evaluateFreshness(rows, TUE_NOON_JST);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ check: "weekly", format: "original", ageDays: 10 });
    expect(r.errors[0].message).toContain("original");
    expect(r.errors[0].message).toContain("10日前");
  });

  it("snapshot が8日以上古い → fail / 7日なら ok (閾値は「以上」)", () => {
    const stale = evaluateFreshness(rowsOf("2026-11-01", "2026-10-26", "2026-11-01"), TUE_NOON_JST);
    expect(stale.ok).toBe(false);
    expect(stale.errors.map((e) => [e.check, e.format, e.ageDays])).toEqual([
      ["snapshot", "original", 8],
      ["snapshot", "advance", 8],
    ]);

    const fresh = evaluateFreshness(rowsOf("2026-11-01", "2026-10-27", "2026-11-01"), TUE_NOON_JST);
    expect(fresh.ok).toBe(true);
  });

  it("format が片方しかない (advance の行がない) → fail", () => {
    const rows = rowsOf("2026-11-01", "2026-11-03", "2026-11-01");
    rows.snapshot = [{ format: "original", latest: "2026-11-03" }];
    const r = evaluateFreshness(rows, TUE_NOON_JST);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ check: "snapshot", format: "advance", latest: null });
    expect(r.errors[0].message).toContain("行がありません");
  });

  it("テーブルが空 (全 format の行がない) → fail", () => {
    const r = evaluateFreshness(rowsOf(null, null, null), TUE_NOON_JST);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(4); // weekly ×2 + snapshot ×2
    expect(r.warnings).toHaveLength(2); // events ×2
  });

  it("JST の日付境界 (UTC 15:00 前後) で日数がずれない", () => {
    expect(jstDate(new Date("2026-11-01T14:59:59Z"))).toBe("2026-11-01");
    expect(jstDate(new Date("2026-11-01T15:00:00Z"))).toBe("2026-11-02");

    const rows = rowsOf("2026-11-01", "2026-10-25", "2026-11-01");
    // JST 11/01 23:59:59 → snapshot は7日前 → ok
    const before = evaluateFreshness(rows, new Date("2026-11-01T14:59:59Z"));
    expect(before.ok).toBe(true);
    // JST 11/02 00:00:00 → 8日前 → fail
    const after = evaluateFreshness(rows, new Date("2026-11-01T15:00:00Z"));
    expect(after.ok).toBe(false);
    expect(after.errors[0]).toMatchObject({ check: "snapshot", ageDays: 8 });
  });

  it("個別CSだけ古い → ok + warning (失敗にはしない)", () => {
    const r = evaluateFreshness(rowsOf("2026-11-01", "2026-11-03", "2026-10-20"), TUE_NOON_JST);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => [w.check, w.format, w.ageDays])).toEqual([
      ["events", "original", 14],
      ["events", "advance", 14],
    ]);
  });

  it("閾値を引数で変えられる", () => {
    const rows = rowsOf("2026-10-24", "2026-11-03", "2026-11-01");
    expect(evaluateFreshness(rows, TUE_NOON_JST).ok).toBe(false);
    expect(
      evaluateFreshness(rows, TUE_NOON_JST, { ...DEFAULT_THRESHOLDS, weeklyMaxAge: 11 }).ok,
    ).toBe(true);
  });
});

describe("parseFreshnessArgs", () => {
  it("引数なしは既定値 (週次9日 / snapshot 8日 / 個別CS 14日)", () => {
    expect(parseFreshnessArgs([])).toEqual({
      weeklyMaxAge: 9,
      snapshotMaxAge: 8,
      eventsMaxAge: 14,
    });
  });

  it("--key=N で上書きできる", () => {
    expect(parseFreshnessArgs(["--weekly-max-age=12", "--snapshot-max-age=10"])).toEqual({
      weeklyMaxAge: 12,
      snapshotMaxAge: 10,
      eventsMaxAge: 14,
    });
  });

  it("不正な値・未知のキーは null", () => {
    expect(parseFreshnessArgs(["--weekly-max-age=abc"])).toBeNull();
    expect(parseFreshnessArgs(["--weekly-max-age=0"])).toBeNull();
    expect(parseFreshnessArgs(["--weekly-max-age=-1"])).toBeNull();
    expect(parseFreshnessArgs(["--weekly-max-age"])).toBeNull();
    expect(parseFreshnessArgs(["--unknown=3"])).toBeNull();
  });
});

// 以下の接続情報はすべて架空の値 (本物の project ref ではない)。
const FAKE_HOST = "aws-0-ap-northeast-1.pooler.supabase.com";
const FAKE_USER = "postgres.abcdefghijklmnopqrst";
const FAKE_URL = `postgresql://${FAKE_USER}:fake-p%40ss@${FAKE_HOST}:6543/postgres`;

describe("describeRunError (公開 Issue に出す1行)", () => {
  it("code と name だけを出し、message は出さない", () => {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${FAKE_HOST}`), {
      code: "ENOTFOUND",
      hostname: FAKE_HOST,
    });
    const s = describeRunError(err);
    expect(s).toBe("code=ENOTFOUND name=Error");
    expect(s).not.toContain("supabase");
  });

  it("英数字と _ 以外を含む code / name は捨てる", () => {
    expect(describeRunError({ code: `bad ${FAKE_USER}`, name: "PostgresError" })).toBe(
      "name=PostgresError",
    );
    expect(describeRunError({ code: "28P01" })).toBe("code=28P01");
  });

  it("オブジェクトでなければ「詳細なし」", () => {
    expect(describeRunError(`connect to ${FAKE_HOST} failed`)).toBe("詳細なし");
    expect(describeRunError(undefined)).toBe("詳細なし");
  });
});

describe("freshness-redact.py (Issue / Step Summary に貼る前の伏せ字)", () => {
  const script = fileURLToPath(
    new URL("../../../.github/scripts/freshness-redact.py", import.meta.url),
  );
  const redact = (input: string, databaseUrl = FAKE_URL) =>
    execFileSync("python3", ["-I", script], {
      input,
      env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    });

  it("DATABASE_URL のホスト・ユーザー・パスワードを *** にする", () => {
    const out = redact(
      [
        `error: connect ECONNREFUSED ${FAKE_HOST}:6543`,
        `password authentication failed for user "${FAKE_USER}"`,
        "pass=fake-p@ss raw=fake-p%40ss",
      ].join("\n"),
    );
    expect(out).not.toContain(FAKE_HOST);
    expect(out).not.toContain("abcdefghijklmnopqrst");
    expect(out).not.toContain("fake-p");
    expect(out).toContain("ECONNREFUSED");
  });

  it("DATABASE_URL が無くても、接続文字列・IP・Supabase のホストとユーザーは伏せる", () => {
    const out = redact(
      [
        `url ${FAKE_URL}`,
        "connect ETIMEDOUT 203.0.113.7:5432",
        "connect ENETUNREACH (2001:db8::1)",
        "host db.zyxwvutsrqponmlkjihg.supabase.co",
        "user postgres.zyxwvutsrqponmlkjihg",
      ].join("\n"),
      "",
    );
    expect(out).not.toMatch(/supabase|203\.0\.113|2001:db8|zyxwvuts|abcdefgh/);
    expect(out.split("\n")).toHaveLength(5);
  });

  it("::error:: / ::warning:: を読みやすくし、鮮度の判定文はそのまま残す", () => {
    const line = "メタスナップショット / original: 最終日 2026-10-26 は 8日前";
    expect(redact(`::error::${line}\n::warning::x\n`)).toBe(`error: ${line}\nwarning: x\n`);
  });
});

/**
 * Issue 起票スクリプトを、偽の `gh` (PATH の先頭に置く) で動かす。
 * 偽 gh は呼ばれた引数を記録し、`issue list` には MOCK_LIST_JSON を **本物の jq** で
 * `--jq` の式にかけて返す (タイトルの完全一致フィルタそのものを確かめるため)。
 */
describe("freshness-issue.sh (偽の gh で重複防止を確認)", () => {
  const script = fileURLToPath(
    new URL("../../../.github/scripts/freshness-issue.sh", import.meta.url),
  );
  const title = "[freshness] 取込データが古くなっています";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "issue list" ]; then
  expr=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--jq" ]; then expr="$2"; fi
    shift
  done
  printf '%s' "$MOCK_LIST_JSON" | jq -r "$expr"
fi
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
  });
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function run(list: Array<{ number: number; title: string }>) {
    const log = join(dir, "gh.log");
    const out = execFileSync("bash", [script], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_LOG: log,
        MOCK_LIST_JSON: JSON.stringify(list),
        RUN_URL: "https://github.com/o/r/actions/runs/1",
        REPORT: "error: メタスナップショット / original: 最終日 2026-10-26 は 8日前",
      },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    return { last: out.trim().split("\n").pop(), calls };
  }

  it("同じタイトルの open Issue が無ければ起票する", () => {
    const { last, calls } = run([{ number: 3, title: "別の Issue" }]);
    expect(last).toBe("created");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^issue list --state open/);
    expect(calls[1]).toContain(`issue create --title ${title}`);
  });

  it("同じタイトルの open Issue があればコメントだけ (起票しない)", () => {
    const { last, calls } = run([
      { number: 3, title: "別の Issue" },
      { number: 42, title },
    ]);
    expect(last).toBe("commented #42");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/^issue comment 42 --body-file /);
    expect(calls.some((c) => c.startsWith("issue create"))).toBe(false);
  });

  it("タイトルが似ているだけ (前方一致・接尾辞つき) の Issue には追記しない", () => {
    const { last } = run([{ number: 7, title: `${title} (解決済みメモ)` }]);
    expect(last).toBe("created");
  });
});

describe.skipIf(!hasTestDb)("check:freshness (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    const { closeDb } = await import("@dm-ai/db");
    await closeDb();
    await sql.end();
  });

  async function counts() {
    const [r] = await sql`SELECT
      (SELECT count(*)::int FROM archetype_weekly_stats) AS weekly,
      (SELECT count(*)::int FROM meta_snapshots) AS snapshots,
      (SELECT count(*)::int FROM tournament_results) AS events`;
    return r;
  }

  /** YYYY-MM-DD を n 日ずらす */
  const shift = (date: string, n: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  /** 各 format に「最新の行」と「その7日前の行」を入れる (max を見ていることの確認用) */
  async function seed(weeklyEnd: string, snapshotEnd: string) {
    for (const format of ["original", "advance"]) {
      await sql`INSERT INTO archetype_weekly_stats
        (format, period_start, period_end, deck_archetype, entries, total_entries)
        VALUES (${format}, ${shift(weeklyEnd, -13)}, ${shift(weeklyEnd, -7)}, 'ウィリデ', 10, 20),
               (${format}, ${shift(weeklyEnd, -6)}, ${weeklyEnd}, 'ウィリデ', 10, 20)`;
      await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
        VALUES (${format}, ${shift(snapshotEnd, -35)}, ${shift(snapshotEnd, -7)}, ${sql.json([])}),
               (${format}, ${shift(snapshotEnd, -28)}, ${snapshotEnd}, ${sql.json([])})`;
      await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
        VALUES ('CS', ${weeklyEnd}, ${format}, 'アグロ', 1)`;
    }
  }

  it("新しいデータなら ok (format ごとの max を見る)", async () => {
    await seed("2026-11-01", "2026-11-02");
    const { runCheckFreshness } = await import("../src/jobs/check-freshness.js");
    const r = await runCheckFreshness(DEFAULT_THRESHOLDS, TUE_NOON_JST);
    expect(r.ok).toBe(true);
    const snap = r.findings.find((f) => f.check === "snapshot" && f.format === "advance");
    expect(snap).toMatchObject({ latest: "2026-11-02", ageDays: 1 });
  });

  it("snapshot が8日古ければ fail し、行は一切変わらない (SELECT だけ)", async () => {
    await seed("2026-11-01", "2026-10-26");
    const before = await counts();
    const { runCheckFreshness } = await import("../src/jobs/check-freshness.js");
    const r = await runCheckFreshness(DEFAULT_THRESHOLDS, TUE_NOON_JST);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.check)).toEqual(["snapshot", "snapshot"]);
    expect(await counts()).toEqual(before);
  });

  /** CLI を子プロセスで動かす (workflow と同じ入口)。exit code を返す */
  function runCli(args: string[] = []) {
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const entry = fileURLToPath(new URL("../src/jobs/check-freshness.ts", import.meta.url));
    const r = spawnSync(tsx, [entry, ...args], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout };
  }

  it("CLI: snapshot が8日前 → exit 1 (= workflow の check が失敗し open-issue job が動く)", async () => {
    // CLI は実時刻で判定するので、今日 (JST) を基準に日付を作る
    const today = jstDate(new Date());
    await seed(shift(today, -2), shift(today, -8));
    const stale = runCli();
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/::error::メタスナップショット .* \/ original: .* 8日前/);

    // 閾値を引数で緩めれば通る (手動実行での誤検知回避)
    expect(runCli(["--snapshot-max-age=9"]).status).toBe(0);
  });

  it("CLI: 新しいデータなら exit 0", async () => {
    const today = jstDate(new Date());
    await seed(today, today);
    const r = runCli();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("鮮度チェック: OK");
  });

  it("空の DB は fail (行が無い = 古い)", async () => {
    const { runCheckFreshness } = await import("../src/jobs/check-freshness.js");
    const r = await runCheckFreshness(DEFAULT_THRESHOLDS, TUE_NOON_JST);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(4);
  });
});
