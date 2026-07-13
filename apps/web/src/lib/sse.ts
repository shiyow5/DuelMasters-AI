/**
 * SSE のフレームを行単位で組み立てる。
 *
 * `EventSource` は GET しかできないので、チャットは fetch + ReadableStream で受けて
 * 自前でパースする。仕様どおり `event:` と `data:` が来て空行で1フレーム。
 * `data:` は複数行に分かれうるので改行で連結する。
 *
 * ネットワークのチャンク境界はフレーム境界と一致しない。行の途中で切れた分はバッファに
 * 残して次のチャンクとつなぐ (ここを間違えると回答が文字化けする)。
 */
export function createSseParser(onEvent: (event: string, data: string) => void) {
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) onEvent(currentEvent, dataLines.join("\n"));
    currentEvent = "message";
    dataLines = [];
  };

  const push = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    // 最後の要素は改行で終わっていない = 途中で切れている可能性があるので残す
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        flush();
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // id: / retry: / コメント行 (:) は使わないので無視する
    }
  };

  return {
    push,
    /** ストリーム終端。改行で終わっていない最後のフレームを取りこぼさない。 */
    end() {
      if (buffer !== "") push("\n");
      flush();
    },
  };
}
