import { describe, it, expect, vi } from "vitest";
import { fetchPublicPage } from "../src/routes/meta.js";

const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

/** URL → Response の対応表から fetch モックを作る */
const mockFetch = (table: Record<string, () => Response>) =>
  vi.fn(async (input: string | URL | Request) => {
    const f = table[String(input)];
    if (!f) throw new Error(`unexpected fetch: ${String(input)}`);
    return f();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("fetchPublicPage (#252)", () => {
  it("(a) 公開→公開のリダイレクトは成功し manual で呼ぶ", async () => {
    const f = mockFetch({
      "https://a.example.com/x": () => redirect("/y"),
      "https://a.example.com/y": () => new Response("hello"),
    });
    await expect(fetchPublicPage("https://a.example.com/x", f)).resolves.toBe("hello");
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it.each(["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/"])(
    "(b) 公開→%s へのリダイレクトは拒否 (fetch しない)",
    async (target) => {
      const f = mockFetch({
        "https://a.example.com/x": () => redirect(target),
      });
      await expect(fetchPublicPage("https://a.example.com/x", f)).rejects.toThrow(
        "許可されていない URL",
      );
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it("Location の無い 3xx はエラー", async () => {
    const f = mockFetch({
      "https://a.example.com/": () => new Response(null, { status: 302 }),
    });
    await expect(fetchPublicPage("https://a.example.com/", f)).rejects.toThrow("Location");
  });

  it("(c) ホップ上限 (3) 超過はエラー", async () => {
    const f = mockFetch({
      "https://a.example.com/0": () => redirect("/1"),
      "https://a.example.com/1": () => redirect("/2"),
      "https://a.example.com/2": () => redirect("/3"),
      "https://a.example.com/3": () => redirect("/4"),
      "https://a.example.com/4": () => new Response("ok"),
    });
    await expect(fetchPublicPage("https://a.example.com/0", f)).rejects.toThrow("多すぎ");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("(c') ちょうど 3 ホップなら成功", async () => {
    const f = mockFetch({
      "https://a.example.com/0": () => redirect("/1"),
      "https://a.example.com/1": () => redirect("/2"),
      "https://a.example.com/2": () => redirect("/3"),
      "https://a.example.com/3": () => new Response("ok"),
    });
    await expect(fetchPublicPage("https://a.example.com/0", f)).resolves.toBe("ok");
  });

  it("(d) タイムアウト (10 秒) で中断される", async () => {
    // AbortSignal.timeout は内部タイマーで fake timers が効かないため、制御可能な signal に差し替える
    const ctrl = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctrl.signal);
    try {
      const f = vi.fn(
        (_u: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
          }),
      ) as unknown as typeof fetch;
      const p = fetchPublicPage("https://a.example.com/", f);
      ctrl.abort(new DOMException("timeout", "TimeoutError"));
      await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("(e) Content-Length 超過は本文を読まず拒否", async () => {
    const f = mockFetch({
      "https://a.example.com/": () =>
        new Response("x", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    });
    await expect(fetchPublicPage("https://a.example.com/", f)).rejects.toThrow("上限");
  });

  it("(f) Content-Length 無しでもストリーム累計が上限超過なら中断", async () => {
    const chunk = new Uint8Array(512 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(chunk); // 無限に流す
      },
    });
    const f = mockFetch({
      "https://a.example.com/": () => new Response(body),
    });
    await expect(fetchPublicPage("https://a.example.com/", f)).rejects.toThrow("上限");
    expect(pulled).toBeLessThan(10);
  });
});
