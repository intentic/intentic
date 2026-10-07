import { randomBytes, randomUUID } from "node:crypto";
import { CONTROL_SCOPES, type ControlReach, type ControlScope, ControlScopeSchema, roleAtLeast, sandboxRouteFor } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { ManifestUnreadableError } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";
import { tokenEquals } from "../auth.js";
import { routeFloor } from "../role-floor.js";

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

// On the history volume beside the roster: a token file in the workspace let a turn plant a token of its own. Until
// 2026-10-06 it sat at `.intentic/identity/control-tokens.json`.
export const controlTokensDocument = defineDocument({ root: "history", path: "identity/control-tokens.json", schema: StoredTokensSchema });

export type ControlTokenSummary = Omit<StoredToken, "hash">;

// What a presented token resolves to: enough to scope the request and to sign its work.
export interface ResolvedControlToken {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
    // Whose authority it carries, when a signed-in person minted it.
    readonly createdBy?: string;
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
    // The token this secret is, or undefined if no live stored token matches (unknown, revoked, or expired); throws
    // ControlTokensUnreadableError when the file exists and this build cannot read it, which says nothing about the token.
    // One lookup answers whether it's real, how far it reaches, and what it's called, which the middleware needs all at
    // once.
    readonly resolve: (presented: string, now?: number) => Promise<ResolvedControlToken | undefined>;
    // Record that the token just authorized a request. Coalesced to one write per TOUCH_INTERVAL_MS per token.
    readonly touch: (id: string, now?: number) => Promise<void>;
    readonly list: () => Promise<ControlTokenSummary[]>;
    readonly revoke: (id: string) => Promise<boolean>;
}

// The token file exists and this build cannot read it: every token in it is unknowable rather than unknown, so the
// grant answers unavailable (503) instead of telling a holder its token is dead.
export class ControlTokensUnreadableError extends Error {
    readonly detail: string;
    constructor(detail: string) {
        super(`the control-token file could not be read (${detail})`);
        this.name = "ControlTokensUnreadableError";
        this.detail = detail;
    }
}

export const fileControlTokens = (path: string): ControlTokens => {
    // Refused rather than set aside when this build cannot read it: setting it aside on the next mint would revoke every
    // other token at once. A write over it throws ManifestUnreadableError.
    const file = openDocument<typeof controlTokensDocument, StoredTokens>(controlTokensDocument, path, {
        unknownKeys: true,
        fallback: () => ({ tokens: [] }),
        onUnreadable: "refuse",
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
            // `state`, not `read`: an unreadable file's empty fallback would answer every token as unknown.
            const stored = await file.state();
            if (stored.unreadable) {
                throw new ControlTokensUnreadableError(stored.detail);
            }
            const hash = sha256Hex(presented);
            // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
            const entry = stored.value.tokens.find((candidate) => tokenEquals(candidate.hash, hash));
            return entry === undefined || !live(entry, now)
                ? undefined
                : { id: entry.id, label: entry.label, scope: entry.scope, ...(entry.createdBy !== undefined ? { createdBy: entry.createdBy } : {}) };
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
            // Over a file this build cannot read, a revoke would find no such token, write nothing, and leave the token
            // to answer again the moment the file was fixed: refused like a mint.
            const tokens = await file.state();
            if (tokens.unreadable) {
                throw new ManifestUnreadableError(path, tokens.detail);
            }
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

// A token is the authority of whoever minted it, held by a program: it answers only while that person still holds the
// operating tier, so removing a maintainer, or re-grading them below it, ends their tokens as it ends their sign-in. A
// token no person minted (a loopback daemon's) answers as before. `operates` is asked per resolve, like the roster.
export const minterBound = (tokens: ControlTokens, operates: (email: string) => Promise<boolean>): ControlTokens => ({
    ...tokens,
    resolve: async (presented, now) => {
        const token = await tokens.resolve(presented, now);
        if (token?.createdBy === undefined) {
            return token;
        }
        // allow(silent-catch): an unreadable roster or owner file answers no, so a token is never honoured on a standing
        // nobody could check.
        return (await operates(token.createdBy).catch(() => false)) ? token : undefined;
    },
});

// What each scope reaches, derived from each route's floor rather than kept as a second list: `read` sees what a viewer
// sees, `drive` does what a collaborator does, `land` adds the one irreversible press. A route's own `control` meta
// (sandbox-contract route-meta.ts) withholds it from every rung, or opens it to one its floor alone would not.
type ScopeReach = (method: string, path: string) => boolean;

// A program reaches only a declared route: a path nothing serves reads as withheld, not as an unclassified read.
const controlOf = (method: string, path: string): ControlReach | undefined => {
    const route = sandboxRouteFor(method, path);
    return route === undefined ? "never" : route.meta.control;
};

const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

// The agent-conversation seam and nothing else: run a turn, answer a parked card, read transcripts, search the tree.
// Declared route by route, since no member role corresponds to this ACP-bridge slice.
const editorReach: ScopeReach = (method, path) => controlOf(method, path) === "editor";

// Observation only: every read a viewer may make, and a read shaped as a POST (/agent/attach carries a replay cursor
// in its body). A person is behind a viewer's request; the routes withheld are ones a program may not open.
const readReach: ScopeReach = (method, path) => {
    const control = controlOf(method, path);
    if (control === "never") {
        return false;
    }
    return control === "read" || (isRead(method) && routeFloor(method, path) === "viewer");
};

// Everything `read` sees, plus making an agent work: every route a collaborator reaches.
// Stops short of anything that moves code into the main tree: those routes floor at maintainer.
const driveReach: ScopeReach = (method, path) => {
    if (readReach(method, path)) {
        return true;
    }
    return controlOf(method, path) !== "never" && roleAtLeast("collaborator", routeFloor(method, path));
};

// `drive` plus the irreversible half: merging a worktree in, or discarding one; kept separate since the usual split is
// a program that works and a person who decides. These are the only maintainer-floored presses a token may hold.
const landReach: ScopeReach = (method, path) => driveReach(method, path) || controlOf(method, path) === "land";

const SCOPE_REACH: Record<ControlScope, ScopeReach> = {
    editor: editorReach,
    read: readReach,
    drive: driveReach,
    land: landReach,
};

export const controlScoped = (scope: ControlScope, method: string, path: string): boolean => SCOPE_REACH[scope](method, path);
