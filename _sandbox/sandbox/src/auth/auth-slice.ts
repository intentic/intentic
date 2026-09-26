import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../env.config.js";
import { type AuthorizeOptions, createAuthorizer, createGoogleVerifier, fileMembersStore, fileOwnerStore, membersDocument, type MembersStore, ownerDocument, ownerTicketVerifier, type PasskeyPolicy, type Proof, type ProvenCaller } from "./auth.js";
import { fileBrowserAccess } from "./browser-access.js";
import { allowedOriginsOf, originAllowedBy } from "./browser-origins.js";
import { type AuthConnections, createAuthConnections } from "./connections.js";
import { createPasskeyCeremonies, filePasskeys, type PasskeyCeremonies, passkeysDocument, type PasskeyStore } from "./passkeys/passkey-store.js";
import { createSessions, type MintedSession } from "./session.js";
import { type ControlTokens, controlTokensDocument, fileControlTokens } from "./tokens/control-tokens.js";
import { type DoorTokens, doorTokensDocument, fileDoorTokens } from "./tokens/door-tokens.js";
import { createMediaTickets, type MediaTickets } from "./tokens/media-tickets.js";
import { createWsTickets, type WsTickets } from "./tokens/ws-tickets.js";

// What authenticates a caller: sessions, per-boot and per-extension tokens, passkeys and the member roster.
export interface AuthSlice {
    // One-shot tickets a WebSocket upgrade presents, minted over bearer-authenticated HTTP since a WS carries no header.
    readonly wsTickets: WsTickets;
    // Path-scoped tickets /workspace/media accepts, for a <video>/<audio> element that cannot header-authenticate.
    readonly mediaTickets: MediaTickets;
    // Per-boot secret in every panel process so it can call the daemon without a browser token; container-only.
    readonly panelToken: string;
    // Per-boot secret the vpn/otp CLIs present; dials/drops tunnels, mints codes, never reads credentials.
    readonly agentToken: string;
    // Owner-minted, hashed, revocable tokens for driving this sandbox outside the browser; each carries its scope.
    readonly controlTokens: ControlTokens;
    // Credentials behind the public doors (webhook, gate, intake tokens); attached to a listing for operators only.
    readonly doorTokens: DoorTokens;
    // Passkeys registered with this sandbox, the require switch and recovery hashes; the daemon is the relying party.
    readonly passkeys: PasskeyStore;
    readonly passkeyCeremonies: PasskeyCeremonies;
    // Shared-access grants besides the owner; the daemon enforces these, the platform only mirrors them.
    readonly members: MembersStore;
    // Bound owner's email, read-only; undefined before the first trust-on-first-use sign-in; binding is elsewhere.
    readonly ownerEmail: () => Promise<string | undefined>;
    // When set, the daemon verifies the bearer on every route but /health and emits CORS; unset means loopback.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined, options?: AuthorizeOptions) => Promise<ProvenCaller>;
              // The roster and policy for a proof the daemon verified itself: a passkey assertion, a recovery code.
              readonly authorizeProven: (proof: Proof) => Promise<ProvenCaller>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
              readonly authorizeRetirement: (bearer: string) => Promise<void>;
              readonly authorizeRecovery: (bearer: string) => Promise<ProvenCaller>;
              readonly mintSession: (proof: Proof) => Promise<MintedSession>;
              // Re-keys the session signer, signing every browser out at once; backs 'sign out everywhere'.
              readonly rotateSessions: () => Promise<void>;
              readonly disableBrowserAccess: () => Promise<void>;
              readonly connections: AuthConnections;
          }
        | undefined;
}

// The sandbox as passkey relying party: the store beside members.json, the ceremonies the routes drive, and the view
// of the store the authorizer's require-passkey policy reads.
const passkeysOf = (
    config: Config,
    workspaceRoot: string,
): { readonly passkeys: PasskeyStore; readonly passkeyCeremonies: PasskeyCeremonies; readonly passkeyPolicy: PasskeyPolicy } => {
    const passkeys = filePasskeys(join(workspaceRoot, passkeysDocument.path));
    const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
    return {
        passkeys,
        passkeyCeremonies: createPasskeyCeremonies({
            store: passkeys,
            originAllowed: originAllowedBy(allowedOriginsOf(config.webOrigin)),
            sandboxId: sandboxIdFromToken(config.connectToken) ?? "",
            sandboxName: config.sandbox.name,
        }),
        passkeyPolicy: {
            required: passkeys.required,
            enrolled: async (email) => (await passkeys.list()).some((credential) => sameEmail(credential.email, email)),
            exists: async (credentialId) => (await passkeys.find(credentialId)) !== undefined,
        },
    };
};

// Builds the auth slice from config; loopback (no Google client id) leaves `auth` undefined, so every route is open.
export const createAuthSlice = (config: Config, workspaceRoot: string): AuthSlice => {
    const members = fileMembersStore(join(workspaceRoot, membersDocument.path));
    const { passkeys, passkeyCeremonies, passkeyPolicy } = passkeysOf(config, workspaceRoot);
    // Bound owner, hoisted since the Access roster and gate routes both need to read, never write, the email.
    const ownerStore = fileOwnerStore(join(workspaceRoot, ownerDocument.path));
    // Session secret under historyRoot, daemon-private and persistent, so a restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authConnections = createAuthConnections();
    const browserAccess = fileBrowserAccess(join(config.historyRoot, "browser-access-disabled"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: ownerStore,
                  members,
                  passkeys: passkeyPolicy,
                  browserAccess,
                  ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  ...(config.owner.email !== "" ? { expectedOwner: config.owner.email } : {}),
                  // Hosted machines only: the provisioner sets the platform's key, checked against this sandbox's id.
                  ...(config.platform.publicKey !== "" && config.connectToken !== ""
                      ? { ownerTicket: ownerTicketVerifier(config.platform.publicKey, sandboxIdFromToken(config.connectToken) ?? "") }
                      : {}),
              })
            : undefined;
    const auth = authorizer
        ? {
              authorize: authorizer.authorize,
              authorizeProven: authorizer.authorizeProven,
              authorizeOwner: authorizer.authorizeOwner,
              authorizeRetirement: authorizer.authorizeRetirement,
              authorizeRecovery: authorizer.authorizeRecovery,
              mintSession: sessions.mint,
              rotateSessions: sessions.rotate,
              disableBrowserAccess: browserAccess.disable,
              connections: authConnections,
          }
        : undefined;
    return {
        wsTickets: createWsTickets(),
        mediaTickets: createMediaTickets(),
        panelToken: randomBytes(32).toString("hex"),
        agentToken: randomBytes(32).toString("hex"),
        controlTokens: fileControlTokens(join(workspaceRoot, controlTokensDocument.path)),
        doorTokens: fileDoorTokens(join(workspaceRoot, doorTokensDocument.path)),
        passkeys,
        passkeyCeremonies,
        members,
        ownerEmail: () => ownerStore.read(),
        auth,
    };
};
