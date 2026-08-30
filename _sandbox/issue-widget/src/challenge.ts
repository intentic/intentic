import type { IssueChallenge } from "@intentic/sandbox-contract";

/* The proof of work, on WRITTEN REPORTS ONLY.
 *
 * Find a nonce whose SHA-256 of `${salt}:${nonce}` begins with `difficulty` zero BITS. It costs the person a
 * second or so and costs a script the same per identity it wants to burn, with no third-party account anywhere.
 *
 * IT DELIBERATELY DOES NOT GUARD CRASHES, and that is a design decision rather than an omission: a crash handler
 * fires on a dying page, where there is no second to spend and nobody waiting to watch it be spent. A puzzle
 * there would not make crash reporting safer, it would make crash reporting not happen. What bounds the crash
 * path is the daemon's grouping, its per-client rate window and its daily ceiling.
 *
 * Solved on the main thread in yielding batches rather than in a Worker: a Worker would have to come from a
 * blob: URL, which the host page's Content-Security-Policy is entitled to forbid, and being unable to send
 * feedback because of the SITE's CSP is a worse failure than a busy second. */
const BATCH = 512;

// Leading zero bits of a digest, up to `wanted`. Stops at the first non-zero byte, so a miss costs one byte.
const leadingZeroBits = (dg: Uint8Array, wanted: number): number => {
    let bits = 0;
    for (const byte of dg) {
        if (byte !== 0) {
            // Math.clz32 counts 32-bit leading zeros; the byte sits in the low 8, so 24 of them are structural.
            return bits + Math.clz32(byte) - 24;
        }
        bits += 8;
        if (bits >= wanted) {
            return bits;
        }
    }
    return bits;
};

// Resolves to the ANSWER the daemon expects, `<salt>:<nonce>`, carrying back the salt it signed so it can
// re-derive the challenge it issued without having stored one.
export const solveProofOfWork = async (challenge: IssueChallenge, onProgress?: (attempts: number) => void): Promise<string> => {
    if (crypto.subtle === undefined) {
        // Only available in a secure context: an http:// page cannot solve this. Say so plainly, since the fix
        // is the site's TLS and nothing the person reporting can do.
        throw new Error("This page must be served over HTTPS to send a report.");
    }
    const encoder = new TextEncoder();
    for (let nonce = 0; ; nonce += 1) {
        const dg = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.salt}:${nonce}`)));
        if (leadingZeroBits(dg, challenge.difficulty) >= challenge.difficulty) {
            return `${challenge.salt}:${nonce}`;
        }
        if (nonce % BATCH === BATCH - 1) {
            onProgress?.(nonce + 1);
            // Hand the main thread back so the page (and our own "checking…" line) keeps painting.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
};
