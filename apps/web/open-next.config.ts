import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext (Cloudflare) の設定。
 *
 * ISR/キャッシュのインクリメンタルキャッシュは使わない。web の 4 ページは api を叩く
 * クライアント側フェッチが主で、サーバー側にキャッシュしたい静的レスポンスが無いため。
 * 必要になったら R2/KV の incrementalCache を足す。
 */
export default defineCloudflareConfig();
