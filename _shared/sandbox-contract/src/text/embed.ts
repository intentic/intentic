// The zod-free half of an embed's wire, shared by the two embeds (webchat-widget, issue-sdk) and the daemon's
// public-door.ts. No imports, ever: this bundles into someone else's page, and the contract's barrel would drag in zod
// (measured at 1.1 MB for two strings).

// Where an embed talks to: the daemon it came from, and the automation it is the public face of.
export interface EmbedEndpoint {
    readonly base: string;
    readonly automationId: string;
}

// The server's own refusal sentence ({"error": ...}), shown verbatim: it names exactly what to fix (e.g. "origin not
// allowed").
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

// Find a nonce whose SHA-256 of `salt:nonce` has `difficulty` leading zero bits, signed to one caller's id so it can't
// be replayed elsewhere. Solved on the main thread, not a Worker: a host's CSP may forbid the blob: URL a Worker needs.
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
            // Math.clz32 counts 32-bit leading zeros; the byte sits in the low 8, so 24 are structural.
            return bits + Math.clz32(byte) - 24;
        }
        bits += 8;
        if (bits >= wanted) {
            return bits;
        }
    }
    return bits;
};

// Resolves to `<salt>:<nonce>`, so the daemon can re-derive the challenge without storing one. insecure is for an
// http:// page: crypto.subtle needs a secure context, and the fix is the site's TLS.
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
            // Hands the main thread back so the page (and the "checking..." line) keeps painting.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
};

// localStorage can throw (Safari private mode, blocked storage); the embed still works, just minting a fresh id per
// load. Silent by design: an embed must never put an error in the console.
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
        // No storage: this load keeps the value in memory, the next one mints another.
    }
};

// A per-browser id, not identity and not a secret: it threads a visitor's messages into one conversation, or bounds a
// rate window per tab.
export const storedId = (name: string): string => {
    const existing = readStored(name);
    if (existing !== undefined && existing !== "") {
        return existing;
    }
    const minted = crypto.randomUUID();
    writeStored(name, minted);
    return minted;
};

// The daemon to talk to is this script's own origin, the one thing a copy-paste can't get wrong; data-base overrides it
// behind a reverse proxy. currentScript is read at module scope, valid only synchronously; querySelector is the
// fallback.
export const embedScript = (srcMatch: string): HTMLScriptElement | null =>
    (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>(`script[src*="${srcMatch}"]`);

// Undefined with no automation id, the one mistake worth flagging: otherwise the embed is silently absent.
export const embedEndpointOf = (script: HTMLScriptElement): EmbedEndpoint | undefined => {
    const automationId = script.dataset["automation"];
    if (automationId === undefined || automationId === "") {
        return undefined;
    }
    return { automationId, base: (script.dataset["base"] ?? new URL(script.src, window.location.href).origin).replace(/\/$/, "") };
};
