import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { tokenEquals } from "./auth.js";
import { type ControlTokens, controlScoped } from "./control-tokens.js";
import type { Principal } from "./principal.js";

// Grants: every credential the daemon accepts instead of the owner's Google bearer, in one table so each fails the same
// way.
// A non-empty header selects a grant and commits the request to it; a bad secret is 401, never a quiet fall-through.
// The empty-string check matters: `tokenEquals("", "")` is true, so an empty secret would authorize every
// unauthenticated request.

export type GrantVerdict = "ok" | "unauthorized" | "out-of-scope";

// What a grant answers.
// `principal` rides only on an admission from a grant whose credential names a party; a per-boot secret admits a
// process and says nothing more.
export type GrantOutcome = { readonly verdict: "ok"; readonly principal?: Principal } | { readonly verdict: "unauthorized" | "out-of-scope" };

const OK: GrantOutcome = { verdict: "ok" };
const UNAUTHORIZED: GrantOutcome = { verdict: "unauthorized" };
const OUT_OF_SCOPE: GrantOutcome = { verdict: "out-of-scope" };

export interface Grant {
    // The header the holder presents its secret in.
    readonly header: string;
    // How a refusal names it (e.g. "sync token"): the credential's name, not the header's.
    readonly name: string;
    readonly authorize: (presented: string, method: string, path: string) => Promise<GrantOutcome>;
}

// The shape three of the four share: one secret fixed for the daemon's lifetime, one static allowlist.
// Scope is checked before the secret on purpose: a wrong-route holder should be told which failure it is, not just
// "your token is wrong".
const fixedSecretGrant = (header: string, name: string, reaches: (method: string, path: string) => boolean, secret: string): Grant => ({
    header,
    name,
    authorize: async (presented, method, path) => {
        if (!reaches(method, path)) {
            return OUT_OF_SCOPE;
        }
        return tokenEquals(presented, secret) ? OK : UNAUTHORIZED;
    },
});

// The vpn/otp/services/capabilities/wallet/agents/secrets CLIs on the agent's PATH reach the daemon over loopback with
// the per-boot agent token.
// Scoped hard: dial/drop configured tunnels, mint expiring codes, spend the owner's credit allowance, ask to connect or
// release a credential — never read a value directly.
// A SET, not more chain clauses: this is an allowlist, every entry of it cost two branches in the chain, and the chain
// was already past the complexity ceiling with a third of these on it. One `METHOD /path` per door, each grouped under
// what it is for.
const EXACT_ROUTES = new Set([
    // The child-agent surface the `agents` CLI drives: start/steer/follow-up a child, answer its question (never its
    // consent cards), list children.
    "POST /children/spawn",
    "POST /children/wait",
    "POST /children/send",
    "POST /children/answer",
    "GET /children",
    "GET /children/providers",
    // Saying something to another conversation in this workspace: the one write under /fleet, and the only door an
    // agent has to a peer that is idle (a child is not, and an idle conversation has no process to message). It puts
    // words in front of a conversation and may start a turn on it, which is what a person does by typing into its
    // chat; it cannot land, archive, rename or discard anything. Rate-limited and attributed in fleet-message.ts.
    "POST /fleet/message",
    // The capability setup gate the `capabilities` CLI drives: discovery (names only, never config) and the ask.
    // The ask parks on an owner-decided card in chat; consent is enforced at the route.
    "GET /capabilities/connectable",
    "POST /capabilities/ask",
    // The wallet surface the `wallet` CLI drives: balance, one paid fetch, history; spend is bounded by the owner's
    // policy twice over. Anything outside the standing auto-approve band parks on an approval card before signing; the
    // container never holds a key.
    "GET /wallet/status",
    "POST /wallet/fetch",
    "GET /wallet/history",
    // The `sandboxes` CLI: the owner's other sandboxes, and the one door a new one is created through. As gated as the
    // wallet's spend — the provisioning token stays with the daemon, and every create parks on a card in the owner's
    // chat before the platform is asked for anything.
    "GET /sandboxes",
    "POST /sandboxes",
    // The credential-approval surface the `secrets` CLI drives, and the only two doors under /secrets this token gets:
    // they answer with names, never values.
    // `gates` tells the model which connected account is withheld so it can ask for the right one instead of guessing;
    // `request` raises the release card and parks (consent checked on the reply).
    "GET /secrets/gates",
    "POST /secrets/request",
]);

// The live-link surfaces the `vpn`, `geo` and `netdisk` CLIs drive: dial/drop a tunnel, start/move/rotate/stop an exit,
// mount/unmount a disk. One bargain for all three: operate what's already configured, never read the credential behind
// it, which stays on the manifest this token never reaches.
const LIVE_LINK_ROUTES = /^\/(?:vpn|exit|netdisk)(?:\/|$)/;

// The conversation-fleet read surface the `agents` CLI drives: which conversations exist, what one is, which said a
// phrase — nothing new, only cheaper than an agent reading the files by hand. A pattern rather than an exact route,
// since the handle is in the path. Not `/agents`: its neighbours land, discard, archive and rename, so a read-only
// namespace here can't grow teeth by accident.
const FLEET_READS = /^\/fleet(?:\/[^/]+)?$/;

// One-time codes for a connected account, by capability id: mint only, never a read of the secret behind it.
const OTP_READS = /^\/capabilities\/[^/]+\/otp$/;

const agentReach = (method: string, path: string): boolean =>
    LIVE_LINK_ROUTES.test(path) ||
    EXACT_ROUTES.has(`${method} ${path}`) ||
    (method === "GET" && (OTP_READS.test(path) || FLEET_READS.test(path)));

// The panel grant is broad on purpose (an open-ended app), except two routes that put a stored credential in motion:
// `/capabilities/<id>/connection` returns a config with secrets included.
// `/capabilities/probe` sends a stored key to a caller-supplied destination instead; both are carved out as denied
// routes, since an allowlist here would be fiction.
const CREDENTIAL_ROUTES = /^\/capabilities\/(?:probe$|[^/]+\/connection$)/;
const panelReach = (_method: string, path: string): boolean => !CREDENTIAL_ROUTES.test(path);

// The desktop-sync agent's two routes: reads the ports list (read-only, never a mutation) and writes its own machine
// report — the only view the daemon ever gets of SYNC_DIR, since that stays local otherwise.
// Also opens the SSH transport (sync-ssh.ts), a bare byte pipe guarded again by sshd's own public-key check against
// this same enrollment's key.
const SYNC_TRANSPORT = "/system/sync/ssh";

const syncReach = (method: string, path: string): boolean =>
    (method === "GET" && path === "/ports") || (method === "GET" && path === SYNC_TRANSPORT) || (method === "POST" && path === "/system/sync/report");

// The grant loop: a non-empty header selects a grant and commits the request to it, the first grant whose header is
// present answers.
// `undefined` means no grant header was presented at all, so the caller falls through to the bearer path.
export type GrantAdmission = { readonly admitted: true; readonly principal?: Principal } | { readonly admitted: false; readonly status: 401 | 403; readonly error: string };

export const admitByGrant = async (
    grants: readonly Grant[],
    header: (name: string) => string | undefined,
    method: string,
    path: string,
): Promise<GrantAdmission | undefined> => {
    for (const grant of grants) {
        const presented = header(grant.header);
        if (presented === undefined || presented === "") {
            continue;
        }
        const outcome = await grant.authorize(presented, method, path);
        if (outcome.verdict === "ok") {
            return outcome.principal === undefined ? { admitted: true } : { admitted: true, principal: outcome.principal };
        }
        // Out of scope is its own answer: the right credential on the wrong route reads "not for this route", not 401.
        return outcome.verdict === "out-of-scope"
            ? { admitted: false, status: 403, error: `${grant.name} not valid for this route` }
            : { admitted: false, status: 401, error: "unauthorized" };
    }
    return undefined;
};

export interface GrantSources {
    readonly panelToken: string;
    readonly agentToken: string;
    readonly controlTokens: ControlTokens;
    // Passed in rather than imported, so this module stays free of platform/ and is testable with a one-line fake.
    // `checkedIn` is true only for the watcher's poll, not the transport; only the poll refreshes the heartbeat.
    readonly verifySync: (presented: string, checkedIn: boolean) => Promise<boolean>;
    // An extension token resolves to its manifest's `permissions.daemon`; unknown token means 401.
    readonly verifyExtension: (presented: string) => { readonly permissions: readonly string[] } | undefined;
}

export const grantsOf = ({ panelToken, agentToken, controlTokens, verifySync, verifyExtension }: GrantSources): readonly Grant[] => [
    fixedSecretGrant("x-intentic-panel", "panel token", panelReach, panelToken),
    fixedSecretGrant("x-intentic-agent", "agent token", agentReach, agentToken),
    {
        // An extension backend's daemon reach: the minted per-extension token resolves to the manifest's
        // `permissions.daemon`, in the same glob grammar the UI half's `permissions.sandbox` uses.
        // So a backend's reach is a declared, reviewable list rather than the all-routes grant a panel token gets.
        header: "x-intentic-extension",
        name: "extension token",
        authorize: async (presented, method, path) => {
            const grant = verifyExtension(presented);
            if (grant === undefined) {
                return UNAUTHORIZED;
            }
            return sandboxRouteAllowed(grant.permissions, method, path) ? OK : OUT_OF_SCOPE;
        },
    },
    {
        header: "x-intentic-control",
        name: "control token",
        authorize: async (presented, method, path) => {
            // Resolve before scoping, unavoidably: a control token's reach is stored with it, so there's no scope to
            // check until the token is known.
            // The inversion leaks less too: an unknown token gets the same answer for every route instead of revealing
            // which ones exist.
            const token = await controlTokens.resolve(presented);
            if (token === undefined) {
                return UNAUTHORIZED;
            }
            if (!controlScoped(token.scope, method, path)) {
                return OUT_OF_SCOPE;
            }
            // Do not let a failed token touch reject an otherwise valid request.
            await controlTokens.touch(token.id).catch(() => undefined);
            return { verdict: "ok", principal: { kind: "control", id: token.id, label: token.label, scope: token.scope } };
        },
    },
    {
        header: "x-intentic-sync",
        name: "sync token",
        authorize: async (presented, method, path) => {
            if (!syncReach(method, path)) {
                return OUT_OF_SCOPE;
            }
            // Not a check-in: the transport is a pipe Mutagen holds open regardless; only the polls refresh the
            // heartbeat.
            return (await verifySync(presented, path !== SYNC_TRANSPORT)) ? OK : UNAUTHORIZED;
        },
    },
];
