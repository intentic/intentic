/* THE ZOD-FREE HALF OF AN EMBED'S WIRE: what every script a customer drops on their own page does before it
 * does anything of its own. Two embeds exist, the Front Desk chat bubble (_sandbox/webchat-widget) and the bug
 * reporter (_sandbox/issue-sdk), and each used to carry its own copy of this: the same three requests
 * against a public door, the same proof-of-work solver, the same localStorage-backed id, the same
 * read-my-own-script-tag boot. The daemon's side of the same doors is one module too (automations/public-door.ts).
 *
 * THE RULE FOR WHAT MAY LIVE HERE: no imports, ever. This module is bundled INTO a page that belongs to someone
 * else, so it must cost that page nothing it did not ask for; the contract's barrel would bring zod with it
 * (webext-links.ts measured that at 1.1 MB for two strings). Types are declared here for the same reason. */

// Where an embed talks to: the daemon it came from, and the automation it is the public face of.
export interface EmbedEndpoint {
    readonly base: string;
    readonly automationId: string;
}

// What the server said when it refused. The daemon answers every refusal as {"error": "..."}, and that sentence
// is shown verbatim where a person can see it: "origin not allowed" tells a site owner exactly what to fix and
// anything invented here would not.
export class EmbedError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "EmbedError";
    }
}

export const embedFailure = async (response: Response): Promise<EmbedError> => {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    return new EmbedError(typeof body?.error === "string" ? body.error : `request failed (${response.status})`, response.status);
};

// One route of a public door: `<base>/<slug>/<automation>/<path>`, the daemon's own spelling.
export const embedUrl = ({ base, automationId }: EmbedEndpoint, slug: string, path: string): string =>
    `${base}/${slug}/${encodeURIComponent(automationId)}/${path}`;

// One GET against a public door, answered as JSON or refused with the server's own sentence.
export const fetchEmbedJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw await embedFailure(response);
    }
    return (await response.json()) as T;
};

/* ---- proof of work ----
 *
 * The daemon issues a challenge: find a nonce whose SHA-256 of `${salt}:${nonce}` begins with `difficulty` zero
 * BITS. It costs the person a second or so and costs a script the same per identity it wants to burn, with no
 * third-party account anywhere. The challenge is minted FOR one caller (the daemon signs the caller's own id
 * into the salt), so a solution cannot be carried to another thread or another reporter; hence the id in the
 * challenge request rather than a bare GET.
 *
 * Solved on the main thread in yielding batches rather than in a Worker: a Worker would have to come from a
 * blob: URL, which a host page's Content-Security-Policy is entitled to forbid, and being unable to chat or send
 * feedback because of the SITE's CSP is a worse failure than a busy second. */
export interface PowChallenge {
    readonly salt: string;
    readonly difficulty: number;
}

export const fetchEmbedChallenge = (endpoint: EmbedEndpoint, slug: string, param: string, id: string): Promise<PowChallenge> =>
    fetchEmbedJson<PowChallenge>(`${embedUrl(endpoint, slug, "challenge")}?${param}=${encodeURIComponent(id)}`);

const BATCH = 512;

// Leading zero bits of a digest, up to `wanted`. Stops at the first non-zero byte, so a miss costs one byte.
const leadingZeroBits = (digest: Uint8Array, wanted: number): number => {
    let bits = 0;
    for (const byte of digest) {
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

/* Resolves to the ANSWER the daemon expects, `<salt>:<nonce>`, carrying back the salt it signed so it can
 * re-derive the challenge it issued without having stored one. `insecure` is what to say on an http:// page:
 * `crypto.subtle` is only available in a secure context, and the fix is the site's TLS, not anything the
 * person can do, so the sentence names the thing they were trying to do. */
export const solveProofOfWork = async (challenge: PowChallenge, insecure: string, onProgress?: (attempts: number) => void): Promise<string> => {
    if (crypto.subtle === undefined) {
        throw new Error(insecure);
    }
    const encoder = new TextEncoder();
    for (let nonce = 0; ; nonce += 1) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.salt}:${nonce}`)));
        if (leadingZeroBits(digest, challenge.difficulty) >= challenge.difficulty) {
            return `${challenge.salt}:${nonce}`;
        }
        if (nonce % BATCH === BATCH - 1) {
            onProgress?.(nonce + 1);
            // Hand the main thread back so the page (and the embed's own "checking…" line) keeps painting.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
};

/* ---- what an embed keeps in the visitor's browser ----
 *
 * localStorage throws in Safari's private mode and anywhere the site blocks storage. An embed with no storage
 * still works; it just mints a fresh id per page load, which costs only a slightly less useful thread or
 * rate-limit key. Silence here is deliberate: an embed must never be the thing that puts an error in the
 * console. */
export const readStored = (name: string): string | undefined => {
    try {
        return window.localStorage.getItem(name) ?? undefined;
    } catch {
        return undefined;
    }
};

export const writeStored = (name: string, value: string): void => {
    try {
        window.localStorage.setItem(name, value);
    } catch {
        /* no storage: this page load keeps the value in memory and the next one mints another */
    }
};

/* A per-browser id under `name`, minted once and kept. NOT identity and NOT a secret: anyone can mint one, and
 * the daemon treats it as exactly what it is, the key that threads a visitor's messages into one conversation,
 * or that a rate window counts against so one runaway tab cannot spend the whole day's budget. */
export const storedId = (name: string): string => {
    const existing = readStored(name);
    if (existing !== undefined && existing !== "") {
        return existing;
    }
    const minted = crypto.randomUUID();
    writeStored(name, minted);
    return minted;
};

/* ---- the <script> tag an embed boots from ----
 *
 *   <script src="https://sandbox-<id>.<zone>/<slug>/…js" data-automation="support" defer></script>
 *
 * Everything else is derived: the daemon to talk to is the ORIGIN THIS SCRIPT CAME FROM, which is the one thing
 * a copy-pasted snippet can't get wrong. `data-base` overrides it for a site fronting the sandbox behind its
 * own proxy, the only case where the two legitimately differ.
 *
 * `document.currentScript` is only valid while the script body is executing, so it is read at module scope by
 * the caller rather than inside an async boot. The querySelector is the fallback for a bundler or tag manager
 * that re-executes the entry in a context where currentScript is null. */
export const embedScript = (srcMatch: string): HTMLScriptElement | null =>
    (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>(`script[src*="${srcMatch}"]`);

// The endpoint a script tag names, or undefined when it carries no automation id, the one mistake worth a
// console line: without it the embed is silently absent and the site owner has nothing to go on.
export const embedEndpointOf = (script: HTMLScriptElement): EmbedEndpoint | undefined => {
    const automationId = script.dataset["automation"];
    if (automationId === undefined || automationId === "") {
        return undefined;
    }
    return { automationId, base: (script.dataset["base"] ?? new URL(script.src, window.location.href).origin).replace(/\/$/, "") };
};
