export interface Chunk {
  text: string;
  meta: {
    section?: string;
    sectionTitle?: string;
    article?: string;
    page?: number;
    url?: string;
  };
}

/**
 * ルールPDFのテキストを条文単位でチャンク化する。
 * 「X.Y.」パターン (例: "100.1.", "101.2a.") で分割。
 *
 * 節見出し (例: "502. ドローステップ") の直後は条文なので、素直に切ると見出し行だけの
 * チャンクが大量にできる。実データでは 600 チャンク中 248 件が本文なしの見出しで、
 * これが検索上位を占有していた。見出しはチャンクにせず、その節の条文の先頭に付けて
 * 埋め込みの文脈にする ("502.1. カードを1枚引きます" だけでは何の話か分からないため)。
 */
export function chunkRuleText(fullText: string): Chunk[] {
  const lines = fullText.split("\n");
  const chunks: Chunk[] = [];
  let sectionHeading = ""; // 例: "502. ドローステップ"
  let sectionTitle = ""; // 例: "ドローステップ"
  let currentSection = "";
  let currentArticle = "";
  let buffer: string[] = [];

  const sectionPattern = /^(\d{3})\.\s/;
  const articlePattern = /^(\d{3}\.\d+[a-z]?)\.\s/;

  function flush() {
    const lines = buffer;
    buffer = [];
    const body = lines.join("\n").trim();
    if (body.length === 0) return;

    // 節見出しから始まるチャンク: 本文が無ければ捨てる (見出しだけのノイズ)
    if (!currentArticle) {
      if (lines.length === 1 && sectionPattern.test(lines[0])) return;
      chunks.push({
        text: body,
        meta: {
          section: currentSection || undefined,
          sectionTitle: sectionTitle || undefined,
        },
      });
      return;
    }

    chunks.push({
      text: sectionHeading ? `${sectionHeading}\n${body}` : body,
      meta: {
        section: currentSection || undefined,
        sectionTitle: sectionTitle || undefined,
        article: currentArticle,
      },
    });
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const articleMatch = trimmed.match(articlePattern);
    if (articleMatch) {
      flush();
      currentArticle = articleMatch[1];
      const sectionNum = articleMatch[1].split(".")[0];
      if (sectionNum) currentSection = sectionNum;
      buffer.push(trimmed);
      continue;
    }

    const sectionMatch = trimmed.match(sectionPattern);
    if (sectionMatch) {
      flush();
      currentSection = sectionMatch[1];
      currentArticle = "";
      sectionHeading = trimmed;
      sectionTitle = trimmed.replace(sectionPattern, "").trim();
      buffer.push(trimmed);
      continue;
    }

    buffer.push(trimmed);
  }

  flush();
  return chunks;
}

/**
 * FAQ / 裁定テキストをQ&A単位でチャンク化する。
 */
export function chunkFaqText(fullText: string): Chunk[] {
  const chunks: Chunk[] = [];
  // Q: ... A: ... のパターンで分割
  const qaPairs = fullText.split(/(?=Q[:：])/);

  for (const pair of qaPairs) {
    const trimmed = pair.trim();
    if (trimmed.length < 10) continue;
    chunks.push({ text: trimmed, meta: {} });
  }

  return chunks;
}

/**
 * 汎用テキスト分割 (サイズベース + オーバーラップ)
 */
export function chunkBySize(text: string, maxChunkSize = 500, overlap = 50): Chunk[] {
  const chunks: Chunk[] = [];
  const sentences = text.split(/(?<=[。．\.\n])/);
  let buffer = "";

  for (const sentence of sentences) {
    if (buffer.length + sentence.length > maxChunkSize && buffer.length > 0) {
      chunks.push({ text: buffer.trim(), meta: {} });
      // オーバーラップ: 最後の overlap 文字を保持
      buffer = buffer.slice(-overlap) + sentence;
    } else {
      buffer += sentence;
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push({ text: buffer.trim(), meta: {} });
  }

  return chunks;
}
