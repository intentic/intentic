// The two browser mounts' names, in a module of their own so a prompt or an arm can name them without pulling the
// Chromium bring-up in (browser-tools.ts re-exports them).
// `web` is always available, credential-free, in-memory profile (--isolated), for ordinary page reads.
// `browser` fronts every signed-in account/identity via one router, one backend per owner, spawned only when named.

// Router's mount point; the observer keys on this to read a call's `account` arg, not the prefix.
export const ROUTED_BROWSER_SERVER = "browser";
// The credential-free browser's mount, and the owner name its single backend and its X display are keyed under.
export const ANONYMOUS_BROWSER_SERVER = "web";
