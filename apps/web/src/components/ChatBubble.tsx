/**
 * チャットバブルの共通コンポーネント。home / rule で角丸・アバター処理を統一する。
 * - アバター: user は "DU" グラデーション、assistant はアイコン (10x10 で統一)
 * - 角丸: rounded-2xl + 送信側の角のみ小さくする (user=右上, assistant=左上)
 * - バブル: glass-bubble-user / glass-bubble-ai (teal 系に統一)
 */
type Role = "user" | "assistant";

export function ChatAvatar({ role, icon = "smart_toy" }: { role: Role; icon?: string }) {
  if (role === "user") {
    return (
      <div className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-tr from-primary to-primary-dark flex items-center justify-center text-[10px] font-bold text-bg-dark shadow-lg shadow-primary/20">
        DU
      </div>
    );
  }
  return (
    <div className="h-10 w-10 shrink-0 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center">
      <span className="material-symbols-outlined text-primary text-xl">{icon}</span>
    </div>
  );
}

/** 応答待ちの「…」。最初のトークンが届くまでの数百ミリ秒を埋める。 */
export function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 150, 300].map((delay) => (
        <div
          key={delay}
          className="h-2 w-2 animate-bounce rounded-full bg-primary/50"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

export default function ChatBubble({
  role,
  name,
  timestamp,
  aiIcon = "smart_toy",
  footer,
  children,
}: {
  role: Role;
  name?: string;
  timestamp?: string;
  aiIcon?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex gap-4 ${isUser ? "flex-row-reverse" : ""}`}>
      <ChatAvatar role={role} icon={aiIcon} />
      <div
        className={`flex flex-col gap-1 min-w-0 max-w-[80%] lg:max-w-[70%] ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        {(name || timestamp) && (
          <div className={`flex items-baseline gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
            {name && <span className="text-sm font-bold text-text-main">{name}</span>}
            {timestamp && <span className="text-[10px] text-text-dim">{timestamp}</span>}
          </div>
        )}
        <div
          className={`p-4 shadow-lg text-text-main rounded-2xl ${
            isUser ? "glass-bubble-user rounded-tr-sm" : "glass-bubble-ai rounded-tl-sm"
          }`}
        >
          {children}
          {footer}
        </div>
      </div>
    </div>
  );
}
