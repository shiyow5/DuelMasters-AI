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

/** 文字列から 0-359 の色相を決定的に得る (アーキタイプのプレースホルダー配色用) */
export function nameToHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
