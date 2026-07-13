import { describe, it, expect } from "vitest";
import { parseAuthHash } from "../src/lib/auth-hash.js";

describe("parseAuthHash", () => {
  it("招待リンクの着地を invite として認識する", () => {
    // Supabase は Site URL へ `#access_token=...&type=invite` で戻してくる。
    const r = parseAuthHash(
      "#access_token=eyJhbGc&expires_in=3600&refresh_token=abc&token_type=bearer&type=invite",
    );
    expect(r.type).toBe("invite");
    expect(r.error).toBeNull();
  });

  it("パスワード再設定リンクも認識する", () => {
    expect(parseAuthHash("#access_token=x&type=recovery").type).toBe("recovery");
  });

  it("期限切れの招待リンクをエラーとして拾う", () => {
    // 実際に踏んだ URL。放置すると Next の 404 やアプリの真っ白画面になり、
    // 何が起きたのか利用者に分からない。
    const r = parseAuthHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=",
    );
    expect(r.error).toBe("otp_expired");
    expect(r.type).toBeNull();
  });

  it("エラーの説明文は + とパーセントを復号する", () => {
    const r = parseAuthHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(r.description).toBe("Email link is invalid or has expired");
  });

  it("通常のログインでは何も返さない", () => {
    expect(parseAuthHash("")).toEqual({ type: null, error: null, description: null });
    expect(parseAuthHash("#")).toEqual({ type: null, error: null, description: null });
    expect(parseAuthHash("#foo=bar")).toEqual({ type: null, error: null, description: null });
  });

  it("先頭の # が無くても読める", () => {
    expect(parseAuthHash("type=invite").type).toBe("invite");
  });

  it("想定外の type は無視する (未知の遷移でパスワード設定画面を出さない)", () => {
    expect(parseAuthHash("#type=magiclink").type).toBeNull();
  });
});
