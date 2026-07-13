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

  async function handleLogout() {
    await supabase!.auth.signOut();
  }

  /**
   * パスワード再設定メールを送る。
   *
   * 招待リンクは一度使うと (あるいは期限が切れると) 二度と使えない。管理者に再招待を
   * 頼まなくても本人が復旧できる導線がないと、招待制の運用が詰まる。
   *
   * `redirectTo` を明示する。Supabase の Site URL が既定 (http://localhost:3000) のままだと
   * メールのリンクがローカルへ飛んで接続拒否になる —— 実際にそれで招待が失敗した。
   */
  async function handleReset() {
    setError("");
    setInfo("");
    if (!email) {
      setError("メールアドレスを入力してください。");
      return;
    }
    setLoading(true);
    const { error } = await supabase!.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // 登録の有無を教えない (アカウントの存在を外部から探れてしまう)。
    setInfo("再設定メールを送信しました。メールをご確認ください。");
  }

  if (userEmail) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-white/5 rounded-xl border border-border-subtle">
        <div className="h-8 w-8 flex-shrink-0 rounded-full bg-gradient-to-tr from-primary to-primary-dark flex items-center justify-center text-[10px] font-bold text-bg-dark shadow-lg shadow-primary/20">
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
      {error && <p className="text-[10px] text-danger">{error}</p>}
      {info && <p className="text-[10px] text-primary">{info}</p>}
      <button
        onClick={handleLogin}
        disabled={loading || !email || !password}
        className="w-full py-1.5 rounded-lg bg-primary/20 text-primary text-xs font-medium hover:bg-primary/30 transition-colors disabled:opacity-50"
      >
        ログイン
      </button>
      {/* 招待制なので新規登録の導線は出さない。Supabase 側でもサインアップを閉じている。
          第三者がアカウントを作れると Gemini の課金を消費されるため。 */}
      <button
        onClick={handleReset}
        disabled={loading || !email}
        className="text-[10px] text-primary hover:underline disabled:opacity-50 disabled:no-underline"
      >
        パスワードを忘れた / 招待リンクが切れた
      </button>
      <p className="text-[10px] text-text-dim">招待されたメールアドレスでログインしてください。</p>
    </div>
  );
}
