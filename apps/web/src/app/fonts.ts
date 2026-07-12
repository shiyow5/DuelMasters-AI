import { Inter, Noto_Sans_JP } from "next/font/google";
import localFont from "next/font/local";

/**
 * フォントは next/font で self-host する (外部 Google Fonts CDN に依存しない)。
 * - Inter / Noto Sans JP: next/font/google がビルド時にダウンロードして self-host。
 * - Material Symbols: next/font/google に存在しないため、woff2 を同梱し next/font/local で self-host。
 *   CDN 障害時にアイコン名(英単語)がそのまま表示される問題を解消する。
 */

export const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

// CJK フォントは巨大なため preload しない (必要な字形は unicode-range で遅延取得)。
export const notoSansJp = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-noto-sans-jp",
  display: "swap",
  preload: false,
});

// アイコンフォント。読み込み前にアイコン名が見えないよう font-display: block。
// フルアイコンセットの可変 woff2 (約4MB) を同梱している。リガチャ名参照のため
// コードポイント指定へ書き換えないと安全にサブセットできない (将来の最適化候補)。
// eager preload で帯域を奪わないよう preload: false とする (Noto Sans JP と同方針)。
export const materialSymbols = localFont({
  src: "./fonts/material-symbols-outlined.woff2",
  variable: "--font-material-symbols",
  display: "block",
  weight: "100 700",
  preload: false,
});
