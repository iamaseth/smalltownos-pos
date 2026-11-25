/**
 * After a deploy, a till still running the old page asks for code files that no longer exist
 * ("Loading chunk failed"). Only a full reload fetches the new version, so reload once; the
 * one-minute guard stops a reload loop if the server itself is down.
 */
const KEY = 'flo-chunk-reload-at';
const GUARD_MS = 60 * 1000;

export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null | undefined;
  const text = `${e?.name ?? ''} ${e?.message ?? (typeof error === 'string' ? error : '')}`;
  return /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(text);
}

/** Reloads the page for a chunk error, at most once a minute. Returns true when it reloads. */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (typeof window === 'undefined' || !isChunkLoadError(error)) return false;
  let last = 0;
  try { last = Number(window.sessionStorage.getItem(KEY) || 0); } catch { /* storage blocked */ }
  if (Date.now() - last < GUARD_MS) return false;
  try { window.sessionStorage.setItem(KEY, String(Date.now())); } catch { /* storage blocked */ }
  window.location.reload();
  return true;
}
