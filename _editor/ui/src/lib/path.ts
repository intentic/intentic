// Splits a workspace path for display: the basename (kept legible) and the directory (dimmable/truncatable).
// String-only, no `node:path`: these run in the browser against posix paths the daemon sends.

export const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// Directory part without a trailing slash; empty at the root, so callers can write `v-if="parentDir(path)"`.
export const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
