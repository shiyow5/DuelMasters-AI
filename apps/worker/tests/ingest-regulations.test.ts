import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseRegulations, runIngestRegulations } from "../src/jobs/ingest-regulations.js";

// 公式サイトの取得はモックする (ネットワークに依存させない)。
const fetchWithRetryMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib.js")>()),
  fetchWithRetry: (...a: unknown[]) => fetchWithRetryMock(...a),
}));

const HTML = `
<h1>殿堂レギュレーション</h1>
<h3>■2026年3月16日より殿堂入りになるカード</h3>
<ul><li><a data-href="/card/detail/?id=x1">《予告カードA》</a></li></ul>
<h2>プレミアム殿堂入りカード</h2>
<h4>「プレミアム殿堂入りカード」とは…？</h4>
<h3>あ行</h3>
<ul><li><a data-href="/card/detail/?id=p1">《アクア・パトロール》</a></li></ul>
<h2>殿堂入りカード</h2>
<h3>あ行</h3>
<ul>
  <li><a data-href="/card/detail/?id=d1">《アポロヌス》</a></li>
  <li><a href="/card/detail/?id=ad">【今すぐ】広告【クリック】</a></li>
</ul>
<h4>「殿堂解除カード」とは…？</h4>
<h3>か行</h3>
<ul><li><a data-href="/card/detail/?id=r1">《解除される旧殿堂》</a></li></ul>
<h2>使用禁止カード</h2>
`;

describe("parseRegulations", () => {
  const entries = parseRegulations(HTML);

  it("h2 制限種別ごとにカードを紐付ける", () => {
    expect(entries.find((e) => e.card_name === "アクア・パトロール")?.restriction_type).toBe(
      "プレミアム殿堂",
    );
    expect(entries.find((e) => e.card_name === "アポロヌス")?.restriction_type).toBe("殿堂入り");
  });

  it("《》を除去し card_id を取る", () => {
    const e = entries.find((x) => x.card_name === "アポロヌス");
    expect(e?.card_id).toBe("d1");
  });

  it("h2 前の予告(announcement)カードは除外", () => {
    expect(entries.some((e) => e.card_name === "予告カードA")).toBe(false);
  });

  it("「殿堂解除」節のカードは除外", () => {
    expect(entries.some((e) => e.card_name === "解除される旧殿堂")).toBe(false);
  });

  it("広告(【】)リンクは除外", () => {
    expect(entries.some((e) => /【/.test(e.card_name))).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("runIngestRegulations フォーマット (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    fetchWithRetryMock.mockResolvedValue(HTML);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("殿堂リストを original と advance の両方に取り込む", async () => {
    // 以前は 'original' 決め打ちで advance が0件になり、アドバンスで殿堂違反を検出できなかった。
    await runIngestRegulations();
    const rows = await sql`SELECT format, count(*)::int AS n FROM regulations GROUP BY format`;
    const byFormat = Object.fromEntries(rows.map((r) => [r.format, r.n]));
    expect(byFormat.original).toBeGreaterThan(0);
    expect(byFormat.advance).toBe(byFormat.original);
  });

  it("再実行しても重複しない (両フォーマットとも入れ替わる)", async () => {
    await runIngestRegulations();
    await runIngestRegulations();
    const rows = await sql`SELECT format, count(*)::int AS n FROM regulations GROUP BY format`;
    const byFormat = Object.fromEntries(rows.map((r) => [r.format, r.n]));
    expect(byFormat.advance).toBe(byFormat.original);
    expect(byFormat.original).toBe(parseRegulations(HTML).length);
  });
});
