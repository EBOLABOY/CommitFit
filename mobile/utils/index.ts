/**
 * Parse JSON content from AI-generated plans into displayable text.
 */
export function parseContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}
