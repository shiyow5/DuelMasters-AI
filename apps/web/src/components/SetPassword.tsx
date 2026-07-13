"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

/** Supabase の既定の最小長。ここで弾いておかないと送信してから怒られる。 */
const MIN_LENGTH = 6;

/**
 * 招待 / パスワード再設定の着地画面。
 *
 * 招待リンクを踏むと Supabase はセッションだけ張って返してくる。**パスワードは未設定**なので、
 * ここで設定させないと、そのセッションが切れた瞬間に二度とログインできなくなる。
 */
export default function SetPassword({ mode }: { mode: "invite" | "recovery" }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < MIN_LENGTH) {
      setError(`パスワードは${MIN_LENGTH}文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("パスワードが一致しません。");
      return;
    }

    setLoading(true);
    const { error } = await supabase!.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
    // ハッシュ (#access_token=...) を URL から消す。残したままリロードされると
    // 設定済みなのに再びこの画面が出る。
    window.history.replaceState(null, "", window.location.pathname);
  }

  if (done) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-2 text-2xl font-bold">パスワードを設定しました</h1>
        <p className="mb-6 text-sm text-text-sub">次回からこのパスワードでログインできます。</p>
        <button
          onClick={() => window.location.reload()}
          className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-bold text-bg-dark"
        >
          はじめる
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm text-left">
      <h1 className="mb-2 text-center text-2xl font-bold">
        {mode === "invite" ? "パスワードを設定" : "パスワードを再設定"}
      </h1>
      <p className="mb-6 text-center text-sm text-text-sub">
        {mode === "invite"
          ? "招待を受け付けました。ログインに使うパスワードを設定してください。"
          : "新しいパスワードを設定してください。"}
      </p>

      <label className="mb-1 block text-xs text-text-sub" htmlFor="new-password">
        新しいパスワード
      </label>
      <input
        id="new-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mb-3 w-full rounded-xl border border-border-subtle bg-white/5 px-4 py-2 text-sm"
      />

      <label className="mb-1 block text-xs text-text-sub" htmlFor="confirm-password">
        確認のためもう一度
      </label>
      <input
        id="confirm-password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="mb-4 w-full rounded-xl border border-border-subtle bg-white/5 px-4 py-2 text-sm"
      />

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-bold text-bg-dark disabled:opacity-50"
      >
        {loading ? "設定中…" : "設定する"}
      </button>
    </form>
  );
}
