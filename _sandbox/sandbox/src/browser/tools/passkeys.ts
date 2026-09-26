import { basename } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import { defineDocument } from "../../store/evolution/documents.js";
import type { JsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";

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

interface PasskeyFile {
    readonly credentials: readonly PasskeyCredential[];
}

// One file per account (`<owner>.passkeys.json`, session-store.ts): declared for its shape and its conversions. Each
// credential as Chromium handed it (PasskeyCredential), kept verbatim: its reader never filters one out, since one
// dropped on read would be dropped from disk by the next write, a key a site still holds the public half of.
const PasskeyFileSchema = z.object({ credentials: z.array(z.unknown()) });
export const browserPasskeysDocument = defineDocument({
    path: stateRelPath(".intentic/local/browser/", "<owner>.passkeys.json"),
    boot: false,
    schema: PasskeyFileSchema,
});

// Private keys a site will ask for again, which nothing can regrow: writes are atomic and queued per path (two pages of
// one account race enrollment against assertion), and content this build can't read is set aside, never written over.
// Set aside rather than refused: the key being saved is one the site already holds the public half of, so refusing it
// would lose it, while the set-aside copy keeps every older one where a hand can put it back.
const passkeyFile = (storePath: string): JsonFile<PasskeyFile> =>
    openDocument(browserPasskeysDocument, storePath, {
        read: (value): PasskeyFile => ({ credentials: value.credentials as PasskeyCredential[] }),
        fallback: () => ({ credentials: [] }),
        mode: 0o600,
    });

export const listPasskeys = async (storePath: string): Promise<readonly PasskeyCredential[]> => (await passkeyFile(storePath).read()).credentials;

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

export const upsertPasskey = async (storePath: string, credential: PasskeyCredential): Promise<void> => {
    await passkeyFile(storePath).update(({ credentials }) => ({
        credentials: [
            ...credentials.filter((entry) => entry.credentialId !== credential.credentialId),
            mergePasskey(
                credentials.find((entry) => entry.credentialId === credential.credentialId),
                credential,
            ),
        ],
    }));
};

// CDP session is the authenticator's whole lifetime: Chromium destroys it silently when the session detaches.
// Kept in a WeakMap keyed by page, so it lives exactly as long as the page and arming stays idempotent per page.
interface Arm {
    readonly cdp: CDPSession;
    // Credentials Chromium would not take back; empty is the only good answer (see armPasskeys).
    readonly refused: readonly string[];
    // Why the store could not be read, when it couldn't: the authenticator is up, holding none of its passkeys.
    readonly unreadable: string | undefined;
}

const armings = new WeakMap<Page, Promise<Arm>>();

const plugIn = async (context: BrowserContext, page: Page, storePath: string, onSaveFailure: (error: unknown) => void): Promise<Arm> => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
    const stored = await passkeyFile(storePath).state();
    const refused: string[] = [];
    for (const credential of stored.value.credentials) {
        // One rotten credential must not unplug the rest; refusals are collected here and raised together below.
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential }).catch(() => refused.push(credential.credentialId));
    }
    // A save that fails loses a key the site now holds the public half of, so it is always reported.
    const save = (credential: PasskeyCredential): void => void upsertPasskey(storePath, credential).catch(onSaveFailure);
    cdp.on("WebAuthn.credentialAdded", (event) => save(event.credential));
    cdp.on("WebAuthn.credentialAsserted", (event) => save(event.credential));
    return { cdp, refused, unreadable: stored.unreadable ? stored.detail : undefined };
};

// Plugs stored credentials into one page's authenticator and wires enrollment/assertion events back to the store.
// Rejects if the store or a stored credential didn't load, instead of swallowing it: the authenticator stays up.
export const armPasskeys = async (context: BrowserContext, page: Page, storePath: string, onSaveFailure: (error: unknown) => void): Promise<void> => {
    let arming = armings.get(page);
    if (arming === undefined) {
        arming = plugIn(context, page, storePath, onSaveFailure);
        armings.set(page, arming);
        // A failed arm isn't remembered, so the page can retry; a refused credential differs: the authenticator is up.
        arming.catch(() => armings.delete(page));
    }
    const { refused, unreadable } = await arming;
    if (unreadable !== undefined) {
        throw new Error(
            `the passkey store ${storePath} could not be read (${unreadable}), so none of its passkeys are loaded; the next enrollment sets it aside as ${basename(storePath)}.corrupt`,
        );
    }
    if (refused.length > 0) {
        throw new Error(`passkeys Chromium would not restore (a credential with no rpId cannot be): ${refused.join(", ")}`);
    }
};
