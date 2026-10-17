import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../env.config.js";
import type { Logger } from "pino";
import {
    type AuthorizeOptions,
    type Authorizer,
    createAuthorizer,
    createGoogleVerifier,
    identityAssertionVerifier,
    type IdTokenVerifier,
    fileMembersStore,
    fileOwnerStore,
    membersDocument,
    operatesSandbox,
    type MembersStore,
    ownerDocument,
    ownerResetCommand,
    type OwnerStore,
    OwnerUnreadableError,
    ownerTicketVerifier,
    type PasskeyPolicy,
    type Proof,
    type ProvenCaller,
} from "./auth.js";
import { assertionsPossible, authEnabled } from "./auth-enabled.js";
import { fileBrowserAccess } from "./browser-access.js";
import { allowedOriginsOf, originAllowedBy } from "./browser-origins.js";
import { type AuthConnections, createAuthConnections } from "./connections.js";
import { createPasskeyCeremonies, filePasskeys, type PasskeyCeremonies, passkeysDocument, type PasskeyStore } from "./passkeys/passkey-store.js";
import { fencedMembers } from "../org/org-roster.js";
import type { OrgPolicyHolder } from "../org/org-policy.js";
import { createPlatformIdentityKey, type PlatformIdentityKey } from "./platform/platform-identity-key.js";
import { createSessions, type MintedSession } from "./session.js";
import { type ControlTokens, controlTokensDocument, fileControlTokens, minterBound } from "./tokens/control-tokens.js";
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
    // The platform's identity key the authorizer verifies assertions with; the announcer hands it each key it is answered.
    readonly platformIdentityKey: PlatformIdentityKey;
    // When set, the daemon verifies the bearer on every route but /health and emits CORS; unset means loopback.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined, options?: AuthorizeOptions) => Promise<ProvenCaller>;
              // The roster and policy for a proof the daemon verified itself: a passkey assertion, a recovery code.
              readonly authorizeProven: (proof: Proof) => Promise<ProvenCaller>;
              readonly authorizeOwner: Authorizer["authorizeOwner"];
              readonly authorizeRetirement: Authorizer["authorizeRetirement"];
              readonly authorizeRecovery: Authorizer["authorizeRecovery"];
              readonly mintSession: (proof: Proof) => Promise<MintedSession>;
              // Re-keys the session signer, signing every browser out at once; backs 'sign out everywhere'.
              readonly rotateSessions: () => Promise<void>;
              readonly disableBrowserAccess: () => Promise<void>;
              readonly connections: AuthConnections;
          }
        | undefined;
}

// The require-passkey switch the authorizer reads, saying once per boot, on the first read that finds the passkeys file
// unreadable, why every sign-in is refused. The read still throws every time: the switch is unknown, and nothing inside
// the sandbox can fix the file, since fixing it takes a sign-in.
const noticedRequired = (passkeys: PasskeyStore, logger: Pick<Logger, "error">): (() => Promise<boolean>) => {
    let said = false;
    return async () => {
        try {
            return await passkeys.required();
        } catch (error) {
            if (!said) {
                said = true;
                logger.error(
                    { err: error },
                    "auth: the passkeys file cannot be read, so every sign-in is refused until it is fixed or moved aside on the history volume",
                );
            }
            throw error;
        }
    };
};

// The sandbox as passkey relying party: its passkey store, the ceremonies the routes drive, and the view
// of the store the authorizer's require-passkey policy reads.
const passkeysOf = (
    config: Config,
    logger: Pick<Logger, "error">,
): { readonly passkeys: PasskeyStore; readonly passkeyCeremonies: PasskeyCeremonies; readonly passkeyPolicy: PasskeyPolicy } => {
    const passkeys = filePasskeys(join(config.historyRoot, passkeysDocument.path));
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
            required: noticedRequired(passkeys, logger),
            enrolled: async (email) => (await passkeys.list()).some((credential) => sameEmail(credential.email, email)),
            exists: async (credentialId) => (await passkeys.find(credentialId)) !== undefined,
        },
    };
};

// The owner store every authorizer and route reads, saying once per boot, on the first read that finds the file
// unreadable, why every sign-in is refused and what a person on the host runs about it. Nothing inside the sandbox can
// fix it, since fixing it takes a sign-in.
const noticedOwnerStore = (store: OwnerStore, logger: Pick<Logger, "error">, connectToken: string): OwnerStore => {
    let said = false;
    return {
        read: async () => {
            try {
                return await store.read();
            } catch (error) {
                if (error instanceof OwnerUnreadableError && !said) {
                    said = true;
                    const remedy = ownerResetCommand(connectToken);
                    logger.error(
                        { detail: error.detail, remedy },
                        `auth: the owner file cannot be read, so every sign-in is refused; on the machine that runs this sandbox, \`${remedy}\` moves it aside so the owner's next sign-in binds the sandbox again`,
                    );
                }
                throw error;
            }
        },
        write: (email, options) => store.write(email, options),
        emailSignIn: async () => (await store.emailSignIn?.()) ?? false,
    };
};

// A daemon with no Google client id refuses every Google proof; it still verifies the platform's identity assertion.
const noGoogle: IdTokenVerifier = () => Promise.reject(new Error("this sandbox takes no Google sign-in"));

// Builds the auth slice from config; loopback (no way to verify anybody, auth-enabled.ts) leaves `auth` undefined, so
// every route is open.
// `orgPolicy` narrows every read of the roster to the people a bound sandbox's organisation lists (org/org-roster.ts);
// without one, or for a personal sandbox, the roster reads as its file says.
export const createAuthSlice = (
    config: Config,
    workspaceRoot: string,
    logger: Pick<Logger, "error">,
    orgPolicy?: Pick<OrgPolicyHolder, "current">,
): AuthSlice => {
    const rosterFile = fileMembersStore(join(config.historyRoot, membersDocument.path));
    const members = orgPolicy === undefined ? rosterFile : fencedMembers(rosterFile, orgPolicy);
    const { passkeys, passkeyCeremonies, passkeyPolicy } = passkeysOf(config, logger);
    // Bound owner, hoisted since the Access roster and gate routes both need to read, never write, the email.
    const ownerStore = noticedOwnerStore(fileOwnerStore(join(config.historyRoot, ownerDocument.path)), logger, config.connectToken);
    // Read once now, so a file that cannot be read is said at boot rather than at the owner's first refused sign-in.
    // allow(silent-catch): the read exists only for the notice above; every sign-in reads the file again.
    void ownerStore.read().catch(() => undefined);
    // Session secret under historyRoot, daemon-private and persistent, so a restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authConnections = createAuthConnections();
    const browserAccess = fileBrowserAccess(join(config.historyRoot, "browser-access-disabled"));
    const platformIdentityKey = createPlatformIdentityKey(config.platform.identityKey);
    const sandboxId = sandboxIdFromToken(config.connectToken) ?? "";
    const authorizer = authEnabled(config)
        ? createAuthorizer({
                  verify: config.google.clientId !== "" ? createGoogleVerifier(config.google.clientId) : noGoogle,
                  session: sessions.verify,
                  owner: ownerStore,
                  members,
                  passkeys: passkeyPolicy,
                  browserAccess,
                  ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  ...(config.owner.email !== "" ? { expectedOwner: config.owner.email } : {}),
                  // Hosted machines only: the provisioner sets the platform's key, checked against this sandbox's id.
                  ...(config.platform.publicKey !== "" && config.connectToken !== ""
                      ? { ownerTicket: ownerTicketVerifier(config.platform.publicKey, sandboxId) }
                      : {}),
                  // The platform's identity assertion: on a hosted machine for anyone on the roster, elsewhere only for
                  // the owner who bound with one and the members the owner opted in (auth.ts `assertionsForAnyone`).
                  identityAssertion: assertionsPossible(config) ? identityAssertionVerifier({ key: platformIdentityKey.settled, sandboxId }) : undefined,
                  assertionsForAnyone: config.sandbox.vm,
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
        controlTokens: minterBound(fileControlTokens(join(config.historyRoot, controlTokensDocument.path)), operatesSandbox(ownerStore, members)),
        doorTokens: fileDoorTokens(join(workspaceRoot, doorTokensDocument.path)),
        passkeys,
        passkeyCeremonies,
        members,
        ownerEmail: () => ownerStore.read(),
        platformIdentityKey,
        auth,
    };
};
