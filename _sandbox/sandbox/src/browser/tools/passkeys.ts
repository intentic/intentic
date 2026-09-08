import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";

// Sandbox-held WebAuthn passkeys over the daemon's CDP window: an owner's hardware key can't reach this container.
// Each connected account gets a virtual authenticator restored from its own store, beside its Chromium profile.
// Per-page authenticator (CDP WebAuthn is target-scoped); an early ceremony could in principle miss the arm.

// CDP WebAuthn.Credential shape, held verbatim: what credentialAdded/Asserted deliver is what addCredential takes back.
// Fields are base64; privateKey is a PKCS#8 EC key.
export interface PasskeyCredential {
    readonly credentialId: string;
    readonly isResidentCredential: boolean;
    readonly rpId?: string;
    readonly privateKey: string;
    readonly userHandle?: string;
    readonly signCount: number;
    readonly userName?: string;
    readonly userDisplayName?: string;
}

// CTAP2 platform authenticator, resident keys, auto verification/presence: completes with nobody there.
const AUTHENTICATOR = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
} as const;

export const listPasskeys = async (storePath: string): Promise<PasskeyCredential[]> => {
    const raw = await readFile(storePath, "utf8").catch(() => undefined);
    if (raw === undefined) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as { credentials?: PasskeyCredential[] };
        return parsed.credentials ?? [];
    } catch {
        // An unreadable store must not take the browser down; the cost is just re-enrolling.
        return [];
    }
};

// Writes serialized per store: two pages of one account could race an enrollment against an assertion.
const writing = new Map<string, Promise<void>>();

// Merges onto what's already stored, never replaces it: a dropped field (rpId especially) can never be plugged in
// again.
// rpId is optional to the CDP type but required by Chromium's addCredential, which otherwise refuses the credential.
export const mergePasskey = (existing: PasskeyCredential | undefined, incoming: PasskeyCredential): PasskeyCredential => {
    if (existing === undefined) {
        return incoming;
    }
    // Absent and undefined are the same fact; only absent is what a real event sends, a raw spread could erase one.
    const learned = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
    return { ...existing, ...learned } as PasskeyCredential;
};

const upsertPasskey = async (storePath: string, credential: PasskeyCredential): Promise<void> => {
    const queued = (writing.get(storePath) ?? Promise.resolve()).then(async () => {
        const stored = await listPasskeys(storePath);
        const kept = stored.filter((entry) => entry.credentialId !== credential.credentialId);
        const previous = stored.find((entry) => entry.credentialId === credential.credentialId);
        await mkdir(dirname(storePath), { recursive: true });
        await writeFile(storePath, JSON.stringify({ credentials: [...kept, mergePasskey(previous, credential)] }, null, 4), {
            mode: 0o600,
        });
    });
    writing.set(
        storePath,
        queued.catch(() => undefined),
    );
    return queued;
};

// CDP session is the authenticator's whole lifetime: Chromium destroys it silently when the session detaches.
// Kept in a WeakMap keyed by page, so it lives exactly as long as the page and arming stays idempotent per page.
interface Arm {
    readonly cdp: CDPSession;
    // Credentials Chromium would not take back; empty is the only good answer (see armPasskeys).
    readonly refused: readonly string[];
}

const armings = new WeakMap<Page, Promise<Arm>>();

const plugIn = async (context: BrowserContext, page: Page, storePath: string): Promise<Arm> => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
    const refused: string[] = [];
    for (const credential of await listPasskeys(storePath)) {
        // One rotten credential must not unplug the rest; refusals are collected here and raised together below.
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential }).catch(() => refused.push(credential.credentialId));
    }
    cdp.on("WebAuthn.credentialAdded", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
    cdp.on("WebAuthn.credentialAsserted", (event) => void upsertPasskey(storePath, event.credential).catch(() => undefined));
    return { cdp, refused };
};

// Plugs stored credentials into one page's authenticator and wires enrollment/assertion events back to the store.
// Rejects if a stored credential didn't load, instead of swallowing it: the rest stay usable regardless.
export const armPasskeys = async (context: BrowserContext, page: Page, storePath: string): Promise<void> => {
    let arming = armings.get(page);
    if (arming === undefined) {
        arming = plugIn(context, page, storePath);
        armings.set(page, arming);
        // A failed arm isn't remembered, so the page can retry; a refused credential differs: the authenticator is up.
        arming.catch(() => armings.delete(page));
    }
    const { refused } = await arming;
    if (refused.length > 0) {
        throw new Error(`passkeys Chromium would not restore (a credential with no rpId cannot be): ${refused.join(", ")}`);
    }
};
