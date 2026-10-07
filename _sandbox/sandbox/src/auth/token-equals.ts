import { timingSafeEqual } from "node:crypto";

// Constant-time comparison of a presented secret with the one held, so timing cannot reveal how much of it matched.
// A module of its own, importing nothing of the daemon's, so a child process (the extension backend host) can compare a
// token without loading the daemon's stores.
// Equal empty strings compare equal: a caller holding a secret that may be empty refuses that case itself.
export const tokenEquals = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};
