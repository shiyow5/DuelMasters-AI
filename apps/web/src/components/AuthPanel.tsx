"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";

export default function AuthPanel() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 環境変数が無い環境では何も表示しない (従来 UI から Guest 表示を消すだけ)
  if (!supabase) return null;

  async function handleLogin() {
    setError("");
    setInfo("");
    setLoading(true);
    const { error } = await supabase!.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setError(error.message);
    setLoading(false);
  }

  async function handleSignup() {
    setError("");
    setInfo("");
    setLoading(true);
    const { error } = await supabase!.auth.signUp({ email, password });
    if (error) setError(error.message);
    else setInfo("確認メールを送信しました(メール確認が有効な場合)");
    setLoading(false);
  }

  async function handleLogout() {
    await supabase!.auth.signOut();
  }

  if (userEmail) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-white/5 rounded-xl border border-border-subtle">
        <div className="h-8 w-8 flex-shrink-0 rounded-full bg-gradient-to-tr from-primary to-primary-purple flex items-center justify-center text-[10px] font-bold text-white shadow-lg shadow-primary/20">
          {userEmail.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs font-medium text-white truncate">{userEmail}</span>
          <button
            onClick={handleLogout}
            className="text-[10px] text-primary text-left hover:underline"
          >
            ログアウト
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="メールアドレス"
        className="w-full bg-bg-dark border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-main placeholder-text-dim focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="パスワード"
        className="w-full bg-bg-dark border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-main placeholder-text-dim focus:outline-none focus:ring-1 focus:ring-primary"
      />
      {error && <p className="text-[10px] text-dm-fire">{error}</p>}
      {info && <p className="text-[10px] text-primary">{info}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleLogin}
          disabled={loading || !email || !password}
          className="flex-1 py-1.5 rounded-lg bg-primary/20 text-primary text-xs font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
        >
          ログイン
        </button>
        <button
          onClick={handleSignup}
          disabled={loading || !email || !password}
          className="flex-1 py-1.5 rounded-lg bg-white/5 text-text-muted text-xs font-medium hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          新規登録
        </button>
      </div>
    </div>
  );
}
