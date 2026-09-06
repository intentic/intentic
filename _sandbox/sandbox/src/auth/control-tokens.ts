import { randomBytes, randomUUID } from "node:crypto";
import { CONTROL_SCOPES, type ControlScope, ControlScopeSchema, roleAtLeast } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";
import { routeFloor } from "./role-floor.js";

/* Control tokens: the credential anything OUTSIDE the browser presents to drive this sandbox, the ACP
 * editor bridge, a CI job, a script, via the `x-intentic-control` header. The sync pairing precedent (owner
 * mints in the browser, a program redeems via header) made durable: PERSISTED (it authenticates every call,
 * not a one-time enrollment: /work/.intentic survives rebuilds with the workspace), HASHED at rest (sha256;
 * the raw `ict_…` value is returned exactly once at mint), and REVOCABLE per token.
 *
 * A token carries its SCOPE, chosen by the owner at mint. Scope is stored WITH the token rather than derived
 * from the caller because the daemon cannot tell an editor from a CLI from a CI job, they are all "a program
 * holding a secret", so the only honest moment to decide how far one reaches is when a person mints it.
 *
 * Say the cost plainly on the mint card: at `drive` and above, a stolen token is the agent's reach, because
 * driving an agent means editing files and running commands in this sandbox. `read` is the one that is
 * genuinely narrower, which is why it exists separately rather than as a politeness.
 */

export { CONTROL_SCOPES, type ControlScope };

const StoredTokenSchema = z.object({
    id: z.string(),
    label: z.string(),
    scope: ControlScopeSchema,
    hash: z.string(),
    createdAt: z.number(),
    // The owner (or maintainer) who minted it, so a roster of tokens says whose decision each one was.
    createdBy: z.string().optional(),
    // Epoch ms after which the token is refused. Absent ⇒ lives until revoked, which is what an editor bridge
    // on the owner's own laptop wants and what a CI secret should probably not have.
    expiresAt: z.number().optional(),
    // Epoch ms of the last request it authorized, coarse on purpose (see touch), the fact that lets a roster say
    // "never used" about a token minted months ago, which is the one most worth revoking.
    lastUsedAt: z.number().optional(),
});
const StoredTokensSchema = z.object({ tokens: z.array(StoredTokenSchema) });
type StoredToken = z.infer<typeof StoredTokenSchema>;
type StoredTokens = z.infer<typeof StoredTokensSchema>;

export type ControlTokenSummary = Omit<StoredToken, "hash">;

// What a presented token resolves to: enough to scope the request and to sign its work.
export interface ResolvedControlToken {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
}

export interface MintOptions {
    readonly createdBy?: string;
    readonly expiresAt?: number;
}

// How often a token's `lastUsedAt` is written. An editor bridge polls; a write per request would turn the token
// file into a hot path for a fact nobody reads to the second.
const TOUCH_INTERVAL_MS = 60_000;

export interface ControlTokens {
    // Returns the RAW token once, only its sha256 is persisted.
    readonly mint: (label: string, scope: ControlScope, options?: MintOptions) => Promise<{ id: string; token: string }>;
    // The token this secret is, or undefined when no live stored token matches (unknown, revoked, or expired).
    // One lookup answers "is this real", "how far does it go" and "what is it called", which is what the
    // middleware needs and what a bare scope could not say.
    readonly resolve: (presented: string, now?: number) => Promise<ResolvedControlToken | undefined>;
    // Record that the token just authorized a request. Coalesced to one write per TOUCH_INTERVAL_MS per token.
    readonly touch: (id: string, now?: number) => Promise<void>;
    readonly list: () => Promise<ControlTokenSummary[]>;
    readonly revoke: (id: string) => Promise<boolean>;
}

export const fileControlTokens = (path: string): ControlTokens => {
    const file = jsonFile<StoredTokens>(path, {
        parse: objectParse(StoredTokensSchema),
        fallback: () => ({ tokens: [] }),
    });
    const live = (entry: StoredToken, now: number): boolean => entry.expiresAt === undefined || entry.expiresAt > now;
    return {
        mint: async (label, scope, options = {}) => {
            const token = `ict_${randomBytes(32).toString("base64url")}`;
            const id = randomUUID();
            await file.update((stored) => ({
                tokens: [
                    ...stored.tokens,
                    {
                        id,
                        label,
                        scope,
                        hash: sha256Hex(token),
                        createdAt: Date.now(),
                        ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
                        ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
                    },
                ],
            }));
            return { id, token };
        },
        resolve: async (presented, now = Date.now()) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
            const entry = (await file.read()).tokens.find((candidate) => tokenEquals(candidate.hash, hash));
            return entry === undefined || !live(entry, now) ? undefined : { id: entry.id, label: entry.label, scope: entry.scope };
        },
        touch: async (id, now = Date.now()) => {
            await file.update((stored) => {
                const entry = stored.tokens.find((candidate) => candidate.id === id);
                if (entry === undefined || (entry.lastUsedAt !== undefined && now - entry.lastUsedAt < TOUCH_INTERVAL_MS)) {
                    // Unchanged by reference: a recent touch, or a token revoked between authorize and here, writes nothing.
                    return stored;
                }
                return { tokens: stored.tokens.map((candidate) => (candidate.id === id ? { ...candidate, lastUsedAt: now } : candidate)) };
            });
        },
        list: async () => (await file.read()).tokens.map(({ hash: _hash, ...summary }) => summary),
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.tokens.filter((entry) => entry.id !== id);
                revoked = next.length !== stored.tokens.length;
                // Unchanged by reference when nothing matched, so revoking an absent id writes nothing.
                return revoked ? { tokens: next } : stored;
            });
            return revoked;
        },
    };
};

/* WHAT EACH SCOPE REACHES, derived from the ROLE FLOORS (role-floor.ts) rather than kept as a second list.
 *
 * The floors already classify every route by the trust tier it demands, and a member is held to them on every
 * request. A control token is a program standing in for a member of some tier: `read` sees what a viewer sees,
 * `drive` does what a collaborator does, `land` adds the one irreversible press a collaborator's grant turns
 * into a request. Deriving the reach from that table means a route added tomorrow lands in the right rung by
 * its floor, and the sentence on the mint card ("everything a viewer sees") is true by construction instead of
 * by somebody remembering to update a regex.
 *
 * Route paths are matched as the daemon receives them (`/agents/abc/land`), not as the contract templates them
 * (`/agents/{id}/land`), these run inside the middleware, before any router has parsed a param. */
type ScopeReach = (method: string, path: string) => boolean;

/* THE SURFACE NO TOKEN REACHES, whatever its floor. A member at viewer tier may open these because a person is
 * behind the request; a program holding a secret may not, because every one of them is about the sandbox's own
 * trust rather than about the work: who may enter (/members), the credentials behind connected accounts and
 * this daemon's own tokens (/secrets, /capabilities, /system), the operator's diagnostics (/logs), exports of
 * the whole state (/bundles), the pairing and enrollment doors, the money (/pool, /wallet), the network
 * (/vpn, /exit), the browser extension's credential lending (/webext), a member's own device notifications
 * (/push), and the child-agent surface the in-container CLI drives (/children). Most of these are
 * maintainer-floored anyway; the list exists for the ones that are not (a viewer may GET /members/self or
 * POST /system/session) and so that the floor table can move without opening a door here. */
const NEVER_PREFIXES: readonly string[] = [
    "/secrets",
    "/capabilities",
    "/members",
    "/system",
    "/logs",
    "/bundles",
    "/enroll",
    "/pool",
    "/wallet",
    "/vpn",
    "/exit",
    "/webext",
    "/push",
    "/children",
];

const never = (path: string): boolean => NEVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const oneOf = (path: string, ...paths: readonly string[]): boolean => paths.includes(path);

const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

// The agent-conversation seam, and nothing else: run a turn, answer a card it parked on, read the transcripts
// and search the tree. This is the ACP bridge's whole job, it drives ONE conversation from an editor, and it
// deliberately cannot see the fleet, land work, or read a capability. Hand-listed, because it is a slice
// rather than a tier: no member role corresponds to it.
const editorReach: ScopeReach = (method, path) => {
    if (method === "POST") {
        return oneOf(path, "/agent", "/agent/reply");
    }
    return isRead(method) && (path === "/sessions" || path.startsWith("/sessions/") || path === "/workspace/search");
};

// Observation only: every read a viewer may make. Attaching to a running turn is a READ that has to be a POST
// (it carries a replay cursor in its body) and is viewer-floored for the same reason, so it rides along.
const readReach: ScopeReach = (method, path) => {
    if (never(path)) {
        return false;
    }
    if (method === "POST" && path === "/agent/attach") {
        return true;
    }
    return isRead(method) && routeFloor(method, path) === "viewer";
};

// Everything `read` sees, plus making an agent work: every route a collaborator reaches. Stops short of anything
// that moves code into the main tree, because those routes floor at maintainer and nothing here names them.
const driveReach: ScopeReach = (method, path) => {
    if (readReach(method, path)) {
        return true;
    }
    return !never(path) && roleAtLeast("collaborator", routeFloor(method, path));
};

// `drive` plus the irreversible half: merging a worktree into the main tree, and throwing one away. Separate
// because the common arrangement is a program that works and a person who decides. CI opens the diff, a human
// presses land. A token that can do both is a choice someone should have to make on purpose. Named rather than
// derived: these are the ONLY maintainer-floored presses a token may ever hold.
const landReach: ScopeReach = (method, path) => {
    if (driveReach(method, path)) {
        return true;
    }
    return method === "POST" && (path === "/agents/purge" || /^\/agents\/[^/]+\/(land|discard)$/.test(path));
};

const SCOPE_REACH: Record<ControlScope, ScopeReach> = {
    editor: editorReach,
    read: readReach,
    drive: driveReach,
    land: landReach,
};

export const controlScoped = (scope: ControlScope, method: string, path: string): boolean => SCOPE_REACH[scope](method, path);
