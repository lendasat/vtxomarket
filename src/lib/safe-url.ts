/** Only allow http/https URLs to prevent javascript: XSS and data: abuse */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {
    /* invalid URL */
  }
  return undefined;
}
