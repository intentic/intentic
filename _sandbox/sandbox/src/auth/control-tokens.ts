import { randomBytes, randomUUID } from "node:crypto";
import { CONTROL_SCOPES, type ControlScope, ControlScopeSchema, roleAtLeast } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";
import { routeFloor } from "./role-floor.js";

// Control tokens: the credential anything outside the browser (an editor bridge, CI, a script) presents via
// `x-intentic-control`; persisted, hashed at rest (sha256, raw value returned once), revocable per token.
// Scope is chosen by the owner at mint and stored with the token, since the daemon can't tell an editor from a CLI from
// CI: only a person can decide the reach.
// At `drive` and above, a stolen token is the agent's reach; `read` is genuinely narrower, which is why it exists
// separately.

export { CONTROL_SCOPES, type ControlScope };

const StoredTokenSchema = z.object({
    id: z.string(),
    label: z.string(),
    scope: ControlScopeSchema,
    hash: z.string(),
    createdAt: z.number(),
    // The owner or maintainer who minted it, so the roster says whose decision each token was.
    createdBy: z.string().optional(),
    // Epoch ms after which the token is refused; absent means it lives until revoked.
    expiresAt: z.number().optional(),
    // Epoch ms of the last authorized request, coarse on purpose; flags a token that's never been used.
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

// How often lastUsedAt is written; per-request writes would make the token file a hot path.
const TOUCH_INTERVAL_MS = 60_000;

export interface ControlTokens {
    // Returns the raw token once; only its sha256 is persisted.
    readonly mint: (label: string, scope: ControlScope, options?: MintOptions) => Promise<{ id: string; token: string }>;
    // The token this secret is, or undefined if no live stored token matches (unknown, revoked, or expired).
    // One lookup answers whether it's real, how far it reaches, and what it's called, which the middleware needs all at
    // once.
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
                    // Unchanged by reference: a recent touch, or a token revoked between authorize and here, writes
                    // nothing.
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

// What each scope reaches, derived from the role floors rather than kept as a second list: `read` sees what a viewer
// sees, `drive` does what a collaborator does, `land` adds the one irreversible press.
// Route paths are matched as received (/agents/abc/land), not as the contract templates them, since this runs before
// any router parses a param.
type ScopeReach = (method: string, path: string) => boolean;

// The surface no token reaches regardless of floor: a viewer member may open these since a person is behind the
// request, but a program may not.
// Roster, credentials and tokens, diagnostics, state exports, pairing doors, money, network, webext lending, push, and
// the child-agent surface.
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

// The agent-conversation seam and nothing else: run a turn, answer a parked card, read transcripts, search the tree.
// Hand-listed rather than derived from a role, since no member role corresponds to this ACP-bridge slice.
const editorReach: ScopeReach = (method, path) => {
    if (method === "POST") {
        return oneOf(path, "/agent", "/agent/reply");
    }
    return isRead(method) && (path === "/sessions" || path.startsWith("/sessions/") || path === "/workspace/search");
};

// Observation only: every read a viewer may make.
// Plus /agent/attach: a read shaped as a POST since it carries a replay cursor in its body.
const readReach: ScopeReach = (method, path) => {
    if (never(path)) {
        return false;
    }
    if (method === "POST" && path === "/agent/attach") {
        return true;
    }
    return isRead(method) && routeFloor(method, path) === "viewer";
};

// Everything `read` sees, plus making an agent work: every route a collaborator reaches.
// Stops short of anything that moves code into the main tree: those routes floor at maintainer and aren't named here.
const driveReach: ScopeReach = (method, path) => {
    if (readReach(method, path)) {
        return true;
    }
    return !never(path) && roleAtLeast("collaborator", routeFloor(method, path));
};

// `drive` plus the irreversible half: merging a worktree in, or discarding one; kept separate since the usual split is
// a program that works and a person who decides.
// Named rather than derived: these are the only maintainer-floored presses a token may ever hold.
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
