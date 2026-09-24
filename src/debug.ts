/** Print model context only when explicitly enabled; it can contain code and PR text. */
export function debugLog(enabled: boolean, label: string, value: unknown): void {
  if (!enabled) return;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  process.stderr.write(`[jev-playwright:debug] ${label}\n${text}\n`);
}
