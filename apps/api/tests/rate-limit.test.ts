import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rateLimitByIp, rateLimitByUser } from "../src/middleware/rate-limit.js";

type Limiter = { limit: ReturnType<typeof vi.fn> };
const mkLimiter = (success = true): Limiter => ({ limit: vi.fn().mockResolvedValue({ success }) });

function buildApp(userId: string | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    return next();
  });
  app.get("/ip", rateLimitByIp, (c) => c.text("ok"));
  app.get("/user", rateLimitByUser, (c) => c.text("ok"));
  return app;
}

const IP = { "cf-connecting-ip": "203.0.113.5" };
const originalAnon = process.env.ALLOW_ANONYMOUS;

function setWorkers(on: boolean) {
  vi.stubGlobal("navigator", { userAgent: on ? "Cloudflare-Workers" : "Node.js/test" });
}

describe("rate-limit", () => {
  beforeEach(() => {
    delete process.env.ALLOW_ANONYMOUS;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalAnon === undefined) delete process.env.ALLOW_ANONYMOUS;
    else process.env.ALLOW_ANONYMOUS = originalAnon;
  });

  describe.each(["/ip", "/user"])("binding 無し (%s)", (path) => {
    it("Workers 本番相当 (ALLOW_ANONYMOUS 無し) は 503", async () => {
      setWorkers(true);
      const res = await buildApp("u1").request(path, { headers: IP }, {});
      expect(res.status).toBe(503);
    });
    it("Workers でも ALLOW_ANONYMOUS=true (env) なら素通し", async () => {
      setWorkers(true);
      const res = await buildApp("u1").request(path, { headers: IP }, { ALLOW_ANONYMOUS: "true" });
      expect(res.status).toBe(200);
    });
    it("Workers でも ALLOW_ANONYMOUS=true (process.env) なら素通し", async () => {
      setWorkers(true);
      process.env.ALLOW_ANONYMOUS = "true";
      const res = await buildApp("u1").request(path, { headers: IP }, {});
      expect(res.status).toBe(200);
    });
    it("Workers でも ALLOW_ANONYMOUS が true 以外なら 503", async () => {
      setWorkers(true);
      const res = await buildApp("u1").request(path, { headers: IP }, { ALLOW_ANONYMOUS: "1" });
      expect(res.status).toBe(503);
    });
    it("Node (ローカル/テスト) は素通し", async () => {
      setWorkers(false);
      const res = await buildApp("u1").request(path, { headers: IP }, {});
      expect(res.status).toBe(200);
    });
  });

  describe("rateLimitByIp (binding あり)", () => {
    it.each([true, false])("Workers=%s: IP をキーに limit を呼び通す", async (workers) => {
      setWorkers(workers);
      const ip = mkLimiter();
      const res = await buildApp().request("/ip", { headers: IP }, { RATE_LIMITER_IP: ip });
      expect(res.status).toBe(200);
      expect(ip.limit).toHaveBeenCalledWith({ key: "203.0.113.5" });
    });
    it("IP 無しは limit を呼ばずに 503", async () => {
      setWorkers(false);
      const ip = mkLimiter();
      const res = await buildApp().request("/ip", {}, { RATE_LIMITER_IP: ip });
      expect(res.status).toBe(503);
      expect(ip.limit).not.toHaveBeenCalled();
    });
    it("success:false は 429", async () => {
      const ip = mkLimiter(false);
      const res = await buildApp().request("/ip", { headers: IP }, { RATE_LIMITER_IP: ip });
      expect(res.status).toBe(429);
    });
  });

  describe("rateLimitByUser (binding あり)", () => {
    it("userId があれば userId をキーにする", async () => {
      const user = mkLimiter();
      const res = await buildApp("supabase:abc").request(
        "/user",
        { headers: IP },
        { RATE_LIMITER_USER: user },
      );
      expect(res.status).toBe(200);
      expect(user.limit).toHaveBeenCalledWith({ key: "supabase:abc" });
    });
    it("userId 無しなら IP をキーにする", async () => {
      const user = mkLimiter();
      const res = await buildApp(null).request(
        "/user",
        { headers: IP },
        { RATE_LIMITER_USER: user },
      );
      expect(res.status).toBe(200);
      expect(user.limit).toHaveBeenCalledWith({ key: "203.0.113.5" });
    });
    it("userId も IP も無ければ limit を呼ばずに 503", async () => {
      const user = mkLimiter();
      const res = await buildApp(null).request("/user", {}, { RATE_LIMITER_USER: user });
      expect(res.status).toBe(503);
      expect(user.limit).not.toHaveBeenCalled();
    });
    it("success:false は 429", async () => {
      const user = mkLimiter(false);
      const res = await buildApp("u1").request(
        "/user",
        { headers: IP },
        { RATE_LIMITER_USER: user },
      );
      expect(res.status).toBe(429);
    });
  });
});
