import { createAuthConnections } from "./connections.js";
import { createPasskeyCeremonies, type PasskeyStore, type StoredCredential, type StoredRecoveryCode } from "./passkeys/passkey-store.js";
import type { ControlScope } from "./tokens/control-tokens.js";
import { memoryDoorTokens } from "./tokens/door-tokens.js";
import { createMediaTickets } from "./tokens/media-tickets.js";
import { createWsTickets } from "./tokens/ws-tickets.js";
import type { AuthSlice } from "./auth-slice.js";

// The auth slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Auth stub refusing every bearer as an AUTHENTICATION failure (401), for testing a route's gate.
export const rejectAuth = async (): Promise<never> => {
    throw new Error("no bearer");
};

// In-memory passkey store: the same seams as the file, so the routes and the authorizer's policy view are testable
// without a temp dir. Starts with nothing required and no credentials.
export const memoryPasskeyStore = (initial: StoredCredential[] = [], required = false): PasskeyStore => {
    let credentials = [...initial];
    let recovery: StoredRecoveryCode[] = [];
    let isRequired = required;
    return {
        list: async () => [...credentials],
        find: async (id) => credentials.find((credential) => credential.id === id),
        add: async (credential) => {
            credentials = [...credentials.filter((entry) => entry.id !== credential.id), credential];
        },
        remove: async (id) => {
            const before = credentials.length;
            credentials = credentials.filter((credential) => credential.id !== id);
            return credentials.length !== before;
        },
        used: async (id, counter, backedUp, now) => {
            credentials = credentials.map((credential) => (credential.id === id ? { ...credential, counter, backedUp, lastUsedAt: now } : credential));
        },
        required: async () => isRequired,
        setRequired: async (value) => {
            isRequired = value;
        },
        recovery: async () => recovery,
        setRecovery: async (hashes) => {
            recovery = hashes.map((hash) => ({ hash }));
        },
        spendRecovery: async (hash, now) => {
            const match = recovery.find((code) => code.usedAt === undefined && code.hash === hash);
            if (match === undefined) {
                return false;
            }
            recovery = recovery.map((code) => (code === match ? { ...code, usedAt: now } : code));
            return true;
        },
    };
};

// One fixed control token per scope, named for it, so a test presents the reach it means; `ict_valid` is editor.
const CONTROL_TOKEN_SCOPES = new Map<string, ControlScope>([
    ["ict_valid", "editor"],
    ["ict_read-token", "read"],
    ["ict_drive-token", "drive"],
    ["ict_land-token", "land"],
]);

// `auth` is too wide to spell out, so a suite passes the members it means and the rest refuse.
export interface AuthFakeOverrides {
    readonly auth?: Partial<NonNullable<AuthSlice["auth"]>> | undefined;
}

// `passkeys`: the suite's own store, if it passed one.
export const authSliceFake = ({ auth }: AuthFakeOverrides, passkeys: AuthSlice["passkeys"] | undefined) => {
    // Shared by the store and the ceremonies over it, so a passkey a test registers is one the same suite can sign in with.
    const passkeyStore = passkeys ?? memoryPasskeyStore();
    return {
        // Real: pure in-memory state with no side effects; a fake would only re-implement the single-use rule.
        wsTickets: createWsTickets(),
        // Real too: the path binding IS what /workspace/media checks, and a fake would only restate it.
        mediaTickets: createMediaTickets(),
        panelToken: "panel-secret",
        // The /vpn-scoped secret the in-container CLI presents; fixed here, minted per boot in production.
        agentToken: "agent-secret",
        // Doors' credentials, in memory; a test seeds one with `ensure`, as an operator copies the URL off the row.
        doorTokens: memoryDoorTokens(),
        controlTokens: {
            mint: async (label, scope) => ({ id: "ct-1", token: `ict_minted-${scope}-${label}` }),
            resolve: async (presented) => {
                const scope = CONTROL_TOKEN_SCOPES.get(presented);
                return scope === undefined ? undefined : { id: `ct-${scope}`, label: `${scope} token`, scope };
            },
            touch: async () => undefined,
            list: async () => [{ id: "ct-1", label: "test", scope: "editor", createdAt: 0 }],
            revoke: async () => true,
        },
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        // Real ceremonies over an empty memory store, every origin allowed: a suite that registers a passkey drives the
        // actual verifier, and one that only lists sees nothing.
        passkeys: passkeyStore,
        passkeyCeremonies: createPasskeyCeremonies({ store: passkeyStore, originAllowed: () => true, sandboxId: "test-sandbox", sandboxName: "test" }),
        // Loopback unless a test asks for the exposed daemon: it's the key's absence, not an override of `undefined`,
        // that means loopback. CORS is separate, emitted in every mode from config.webOrigin.
        auth:
            auth === undefined
                ? undefined
                : {
                      authorize: rejectAuth,
                      authorizeProven: rejectAuth,
                      authorizeOwner: rejectAuth,
                      authorizeRetirement: rejectAuth,
                      authorizeRecovery: rejectAuth,
                      mintSession: async () => ({ token: "sess-token", expiresAt: 0 }),
                      // Owner-only and destructive: an unstubbed call names itself rather than silently answering 200.
                      rotateSessions: async () => {
                          throw new Error("auth.rotateSessions was called, and this test did not stub it");
                      },
                      disableBrowserAccess: async () => {
                          throw new Error("auth.disableBrowserAccess was called, and this test did not stub it");
                      },
                      connections: createAuthConnections(),
                      ...auth,
                  },
    } satisfies Partial<AuthSlice>;
};
