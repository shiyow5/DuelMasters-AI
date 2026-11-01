import localFont from "next/font/local";
// Noto Sans JP (可変, wght 100-900)。fontsource の CSS が unicode-range で 124 分割した
// woff2 を宣言しており、ブラウザは画面に出た字形のスライスだけを取得する。
// font-family 名は 'Noto Sans JP Variable' (--font-noto-sans-jp として globals.css で参照)。
import "@fontsource-variable/noto-sans-jp/wght.css";

/**
 * フォントはすべてリポジトリ / lockfile 固定の npm パッケージから self-host する。
 * ビルド時にも実行時にも外部 (Google Fonts) へ取りに行かない。
 *
 * 以前は next/font/google を使っていたが、ビルド時の fonts.gstatic.com 取得が
 * 不定期に失敗し Deploy が落ちていた (run 41313847647)。そのためネットワーク非依存にした。
 *
 * - Inter: latin の可変 woff2 (wght 100-900, 48KB) を同梱し next/font/local で読む。
 *   出典 @fontsource-variable/inter@5.3.0、ライセンスは同ディレクトリの OFL-Inter.txt。
 * - Noto Sans JP: next/font/local は unicode-range 分割ができず、全字形 (数 MB) を
 *   一度に落とすことになるため、分割済みの @fontsource-variable/noto-sans-jp を使う (OFL-1.1)。
 * - Material Symbols: woff2 を同梱し next/font/local で self-host。
 *   CDN 障害時にアイコン名(英単語)がそのまま表示される問題を解消する。
 */

export const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
});

// アイコンフォント。読み込み前にアイコン名が見えないよう font-display: block。
// フルアイコンセットの可変 woff2 (約4MB) を同梱している。リガチャ名参照のため
// コードポイント指定へ書き換えないと安全にサブセットできない (将来の最適化候補)。
// eager preload で帯域を奪わないよう preload: false とする。
export const materialSymbols = localFont({
  src: "./fonts/material-symbols-outlined.woff2",
  variable: "--font-material-symbols",
  display: "block",
  weight: "100 700",
  preload: false,
});
