/* Splitting a workspace path for DISPLAY — the two halves every file row in the app is built from: the name
 * that must stay legible, and the directory that may be dimmed, truncated or dropped.
 *
 * It lives beside the icon helpers rather than in the app because this library's own file API asks for the
 * split: `iconForEntry(name, …)` and `explorerColorClass(style, name, …)` take a BASENAME, so every caller of
 * those already has to perform it. Nine components had each written their own copy of these two lines.
 *
 * Deliberately string-only, no `node:path`: these run in the browser against posix paths the daemon sends. */

export const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// The directory part, WITHOUT a trailing slash — empty for a path at the root, which is what lets a caller
// write `v-if="parentDir(path)"` instead of comparing against ".".
export const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
