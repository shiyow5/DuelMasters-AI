export interface Chunk {
  text: string;
  meta: {
    section?: string;
    article?: string;
    page?: number;
    url?: string;
  };
}

/**
 * ルールPDFのテキストを条文単位でチャンク化する。
 * 「X.Y.」パターン (例: "100.1.", "101.2a.") で分割。
 */
export function chunkRuleText(fullText: string): Chunk[] {
  const lines = fullText.split("\n");
  const chunks: Chunk[] = [];
  let currentSection = "";
  let currentArticle = "";
  let buffer: string[] = [];

  const sectionPattern = /^(\d{3})\.\s/;
  const articlePattern = /^(\d{3}\.\d+[a-z]?)\.\s/;

  function flush() {
    const text = buffer.join("\n").trim();
    if (text.length > 0) {
      chunks.push({
        text,
        meta: {
          section: currentSection || undefined,
          article: currentArticle || undefined,
        },
      });
    }
    buffer = [];
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
export function chunkBySize(
  text: string,
  maxChunkSize = 500,
  overlap = 50
): Chunk[] {
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
