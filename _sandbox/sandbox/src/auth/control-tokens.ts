import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";

/* Control tokens: the credential anything OUTSIDE the browser presents to drive this sandbox — the ACP
 * editor bridge today, a CLI and an MCP server next — via the `x-intentic-control` header. The sync pairing
 * precedent (owner mints in the browser, a program redeems via header) made durable: PERSISTED (it
 * authenticates every call, not a one-time enrollment — /work/.intentic survives rebuilds with the
 * workspace), HASHED at rest (sha256; the raw `ict_…` value is returned exactly once at mint), and REVOCABLE
 * per token.
 *
 * A token carries its SCOPE, chosen by the owner at mint. Scope is stored WITH the token rather than derived
 * from the caller because the daemon cannot tell an editor from a CLI from a CI job — they are all "a program
 * holding a secret" — so the only honest moment to decide how far one reaches is when a person mints it.
 *
 * Say the cost plainly on the mint card: at `drive` and above, a stolen token is the agent's reach, because
 * driving an agent means editing files and running commands in this sandbox. `read` is the one that is
 * genuinely narrower, which is why it exists separately rather than as a politeness.
 */

// What a token may reach, widening downward. Each is a superset of the one above it EXCEPT `editor`, which is
// its own narrow slice (one conversation) rather than a rung on the ladder — an editor bridge has no business
// reading the fleet, and saying so costs one row.
export const CONTROL_SCOPES = ["editor", "read", "drive", "land"] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];

const ControlScopeSchema = z.enum(CONTROL_SCOPES);

const StoredTokensSchema = z.object({
    tokens: z.array(z.object({ id: z.string(), label: z.string(), scope: ControlScopeSchema, hash: z.string(), createdAt: z.number() })),
});
type StoredTokens = z.infer<typeof StoredTokensSchema>;

export interface ControlTokenSummary {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
    readonly createdAt: number;
}

export interface ControlTokens {
    // Returns the RAW token once — only its sha256 is persisted.
    readonly mint: (label: string, scope: ControlScope) => Promise<{ id: string; token: string }>;
    // The presented token's scope, or undefined when no stored token matches. One lookup answers both "is this
    // real" and "how far does it go", which is what the middleware needs and what a bare boolean could not say.
    readonly scopeOf: (presented: string) => Promise<ControlScope | undefined>;
    readonly list: () => Promise<ControlTokenSummary[]>;
    readonly revoke: (id: string) => Promise<boolean>;
}

export const fileControlTokens = (path: string): ControlTokens => {
    const file = jsonFile<StoredTokens>(path, {
        parse: objectParse(StoredTokensSchema),
        fallback: () => ({ tokens: [] }),
    });
    return {
        mint: async (label, scope) => {
            const token = `ict_${randomBytes(32).toString("base64url")}`;
            const id = randomUUID();
            await file.update((stored) => ({
                tokens: [...stored.tokens, { id, label, scope, hash: sha256Hex(token), createdAt: Date.now() }],
            }));
            return { id, token };
        },
        scopeOf: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
            return (await file.read()).tokens.find((entry) => tokenEquals(entry.hash, hash))?.scope;
        },
        list: async () => (await file.read()).tokens.map(({ id, label, scope, createdAt }) => ({ id, label, scope, createdAt })),
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

/* WHAT EACH SCOPE REACHES.
 *
 * Route paths are matched as the daemon receives them (`/agents/abc/land`), not as the contract templates
 * them (`/agents/{id}/land`) — these run inside the middleware, before any router has parsed a param.
 *
 * Pure, and a total Record over the scope union, so a new scope is a compile error until somebody writes down
 * what it reaches, and every allowlist is unit-tested without a request.
 */
type ScopeReach = (method: string, path: string) => boolean;

const oneOf = (path: string, ...paths: readonly string[]): boolean => paths.includes(path);

// The agent-conversation seam, and nothing else: run a turn, answer a card it parked on, read the transcripts
// and search the tree. This is the ACP bridge's whole job — it drives ONE conversation from an editor, and it
// deliberately cannot see the fleet, land work, or read a capability.
const editorReach: ScopeReach = (method, path) => {
    if (method === "POST") {
        return oneOf(path, "/agent", "/agent/reply");
    }
    return method === "GET" && (path === "/sessions" || path.startsWith("/sessions/") || path === "/workspace/search");
};

// Observation only — the fleet board's data, for a dashboard, a status check, or a phone script. The one scope
// that is genuinely safe to paste somewhere lossy, and the reason the ladder has a bottom rung at all.
const readReach: ScopeReach = (method, path) => {
    if (method === "GET") {
        return (
            path === "/agents" ||
            path.startsWith("/agents/") ||
            path === "/sessions" ||
            path.startsWith("/sessions/") ||
            path === "/workspace/search" ||
            path === "/ports"
        );
    }
    // Attaching to a running turn is a READ that has to be a POST: it carries a replay cursor in its body.
    return method === "POST" && path === "/agent/attach";
};

// Everything `read` sees, plus making an agent work: start a turn, answer it, steer it, stop it, and the
// registry bookkeeping that goes with driving one. Stops short of anything that moves code into the main tree.
const driveReach: ScopeReach = (method, path) => {
    if (readReach(method, path)) {
        return true;
    }
    if (method !== "POST") {
        return false;
    }
    return (
        oneOf(path, "/agent", "/agent/reply", "/agent/steer", "/agent/stop", "/agents/seen") ||
        /^\/agents\/[^/]+\/(seen|rename|auto-land)$/.test(path)
    );
};

// `drive` plus the irreversible half: merging a worktree into the main tree, and throwing one away. Separate
// because the common arrangement is a program that works and a person who decides — CI opens the diff, a human
// presses land. A token that can do both is a choice someone should have to make on purpose.
const landReach: ScopeReach = (method, path) => {
    if (driveReach(method, path)) {
        return true;
    }
    if (method !== "POST") {
        return false;
    }
    return oneOf(path, "/agents/archive", "/agents/unarchive", "/agents/purge") || /^\/agents\/[^/]+\/(land|discard)$/.test(path);
};

const SCOPE_REACH: Record<ControlScope, ScopeReach> = {
    editor: editorReach,
    read: readReach,
    drive: driveReach,
    land: landReach,
};

export const controlScoped = (scope: ControlScope, method: string, path: string): boolean => SCOPE_REACH[scope](method, path);
