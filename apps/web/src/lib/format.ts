/** 現在時刻の "HH:MM" 表記 (チャットのタイムスタンプ用) */
export function getTime(): string {
  return new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 総合スコア → グレード表記 */
export function scoreGrade(overall: number): string {
  if (overall >= 90) return "S+";
  if (overall >= 80) return "S";
  if (overall >= 70) return "A";
  if (overall >= 60) return "B";
  if (overall >= 50) return "C";
  return "D";
}
