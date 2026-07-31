import type { WebchatChallenge } from "@intentic/sandbox-contract";

/* The bot ceiling, in the two flavours the config offers. Both produce ONE token spent on the first message of
 * a visitor thread — a per-message challenge would be a per-message interruption, and the rate limit is what
 * bounds a thread that has already been admitted. */

/* ---- proof of work ----
 *
 * Find a nonce whose SHA-256 of `${salt}:${nonce}` begins with `difficulty` zero BITS. Costs the visitor a
 * second or so and costs a bot the same per identity it wants to burn, with no third-party account anywhere.
 *
 * Solved on the main thread in yielding batches rather than in a Worker: a Worker would have to come from a
 * blob: URL, which a host page's Content-Security-Policy is entitled to forbid — and being unable to chat
 * because of the SITE's CSP is a worse failure than a busy second. */
const BATCH = 512;

// Leading zero bits of a digest, up to `wanted` — stops at the first non-zero, so a miss costs one byte.
const leadingZeroBits = (digest: Uint8Array, wanted: number): number => {
    let bits = 0;
    for (const byte of digest) {
        if (byte === 0) {
            bits += 8;
            if (bits >= wanted) {
                return bits;
            }
            continue;
        }
        // Math.clz32 counts 32-bit leading zeros; the byte sits in the low 8, so 24 of them are structural.
        return bits + Math.clz32(byte) - 24;
    }
    return bits;
};

// Resolves to the ANSWER the daemon expects — `<salt>:<nonce>`, carrying back the salt it signed so it can
// re-derive the challenge it issued without having stored one.
export const solveProofOfWork = async (challenge: WebchatChallenge, onProgress?: (attempts: number) => void): Promise<string> => {
    if (crypto.subtle === undefined) {
        // Only available in a secure context — an http:// site cannot solve this. Say so plainly; the fix is
        // the site's TLS, not anything the visitor can do.
        throw new Error("This page must be served over HTTPS to start a chat.");
    }
    const encoder = new TextEncoder();
    for (let nonce = 0; ; nonce += 1) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.salt}:${nonce}`)));
        if (leadingZeroBits(digest, challenge.difficulty) >= challenge.difficulty) {
            return `${challenge.salt}:${nonce}`;
        }
        if (nonce % BATCH === BATCH - 1) {
            onProgress?.(nonce + 1);
            // Hand the main thread back so the page (and our own "checking…" line) keeps painting.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
};

/* ---- Cloudflare Turnstile ----
 *
 * Rendered explicitly into a container the widget slots from the light DOM, for the same reason as Google's
 * button: it is a third-party iframe and belongs in the document. The SECRET half never appears here — the
 * daemon verifies the token against siteverify. */

interface Turnstile {
    render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => void;
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstileLoad: Promise<Turnstile> | undefined;

const loadTurnstile = async (): Promise<Turnstile> => {
    turnstileLoad ??= new Promise<Turnstile>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = TURNSTILE_SRC;
        script.async = true;
        script.addEventListener("load", () => {
            const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
            if (turnstile === undefined) {
                reject(new Error("The bot check failed to load"));
                return;
            }
            resolve(turnstile);
        });
        script.addEventListener("error", () => reject(new Error("The bot check failed to load")));
        document.head.append(script);
    });
    return turnstileLoad;
};

export const solveTurnstile = async (container: HTMLElement, siteKey: string): Promise<string> => {
    const turnstile = await loadTurnstile();
    return new Promise<string>((resolve, reject) => {
        turnstile.render(container, {
            sitekey: siteKey,
            callback: resolve,
            "error-callback": () => reject(new Error("The bot check failed — reload the page and try again")),
        });
    });
};
