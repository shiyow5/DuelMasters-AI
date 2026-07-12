/**
 * 画面内メッセージ表示を統一するための共通コンポーネント。
 * alert() を使わず、成功/警告/エラー/情報を一貫した見た目で表示する。
 */
export type MessageVariant = "error" | "warning" | "success" | "info";

const VARIANT_STYLES: Record<MessageVariant, string> = {
  error: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/30 bg-warning/10 text-warning",
  success: "border-success/30 bg-success/10 text-success",
  info: "border-primary/30 bg-primary/10 text-primary",
};

const VARIANT_ICONS: Record<MessageVariant, string> = {
  error: "error",
  warning: "warning",
  success: "check_circle",
  info: "info",
};

export default function ErrorDisplay({
  message,
  variant = "error",
  onDismiss,
}: {
  message: string;
  variant?: MessageVariant;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  // error/warning は割り込み通知 (assertive)、success/info は控えめな status に。
  const role = variant === "error" || variant === "warning" ? "alert" : "status";
  return (
    <div
      role={role}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${VARIANT_STYLES[variant]}`}
    >
      <span className="material-symbols-outlined text-[18px] shrink-0">
        {VARIANT_ICONS[variant]}
      </span>
      <p className="flex-1 leading-relaxed break-words">{message}</p>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="閉じる"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      )}
    </div>
  );
}
