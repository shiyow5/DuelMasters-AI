"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import AuthPanel from "./AuthPanel";

/**
 * ログインしていないユーザーにアプリ本体を見せない。
 *
 * api 側は全エンドポイントがログイン必須になったため、未ログインのまま UI を触らせても
 * 401 が並ぶだけで体験が悪い。入口で止めてログインを促す。
 *
 * `ALLOW_ANONYMOUS=true` のときだけ素通しする (E2E とローカル開発)。既定は認証必須。
 * 本番のビルドではこのフラグを立てない (deploy.yml が混入を検査する)。
 */
const ALLOW_ANONYMOUS = process.env.NEXT_PUBLIC_ALLOW_ANONYMOUS === "true";

type State = "loading" | "authed" | "guest";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(ALLOW_ANONYMOUS ? "authed" : "loading");

  useEffect(() => {
    if (ALLOW_ANONYMOUS || !supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setState(data.session ? "authed" : "guest");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(session ? "authed" : "guest");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (ALLOW_ANONYMOUS) return <>{children}</>;

  // 認証が構成されていない本番ビルドは fail-closed にする (誤設定で全開放しない)。
  if (!supabase) {
    return (
      <Centered>
        <p className="text-danger">認証が構成されていません。管理者にお問い合わせください。</p>
      </Centered>
    );
  }

  if (state === "loading") {
    return (
      <Centered>
        <p className="text-text-sub">読み込み中…</p>
      </Centered>
    );
  }

  if (state === "guest") {
    return (
      <Centered>
        <div className="w-full max-w-sm">
          <h1 className="mb-2 text-2xl font-bold">DM AI Master</h1>
          <p className="mb-6 text-sm text-text-sub">
            ご利用にはログインが必要です。アカウントをお持ちでない場合は新規登録してください。
          </p>
          <AuthPanel />
        </div>
      </Centered>
    );
  }

  return <>{children}</>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-6 text-center">{children}</div>
  );
}
