import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { statePath, stateRelPath } from "../state-paths.js";
import { conversationUnit } from "../store/conversation-units.js";

// One conversation's own store, in its unit outside the workspace, so no other conversation's namespace holds it.
export const sessionsDir = (historyRoot: string, id: string): string => join(conversationUnit(historyRoot, id), "sessions");

// Per-conversation state to symlink onto the workspace; settings and skills stay container-local on purpose.
// Exported because a fenced conversation's own store has to hold the same names before its turn starts: the symlinks
// are made once, at boot, against the shared path, and a namespace binds a different directory under them.
export const SESSION_STATE = ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"];

// Effectively "never": the CLI's sweep would now delete real transcripts (0 is rejected by the CLI).
const RETENTION_DAYS = 3650;

// Merges one key into settings.json rather than replacing it, since the user's own settings load from the same file.
// Unreadable or unparseable content propagates rather than being clobbered; losing user settings costs more than the
// sweep this key prevents.
const persistRetention = async (claudeHome: string): Promise<void> => {
    const path = join(claudeHome, "settings.json");
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    const settings: { cleanupPeriodDays?: number } & Record<string, unknown> = raw === undefined ? {} : JSON.parse(raw);
    if (settings.cleanupPeriodDays === RETENTION_DAYS) {
        return;
    }
    await writeFile(path, `${JSON.stringify({ ...settings, cleanupPeriodDays: RETENTION_DAYS }, undefined, 2)}\n`);
};

// Which conversations keep their own store rather than the shared one. Equivalent to a resolved fence (areas-store.ts's
// foldersOf answers undefined for exactly this case), and asked without the area manifest so every reader agrees.
export interface StoreOwner {
    readonly id: string;
    readonly identity: { readonly areas?: readonly string[] | undefined };
}

/**
 * Where a conversation's runtime session state is: its transcripts, plans, backups, shell snapshots and checklists.
 * A conversation born fenced keeps its own, outside the workspace; its turn's namespace binds that over the shared
 * path (agents/worktrees/isolation.ts), so the CLI writing to `~/.claude` and the daemon reading here name one file.
 */
export const claudeStoreOf = (workspaceRoot: string, historyRoot: string, entry: StoreOwner | undefined): string =>
    entry?.identity.areas === undefined ? statePath(workspaceRoot, ".intentic/records/sessions/claude/") : sessionsDir(historyRoot, entry.id);

export const linkClaudeState = async (workspaceRoot: string, home = homedir()): Promise<void> => {
    const store = statePath(workspaceRoot, ".intentic/records/sessions/claude/");
    const claudeHome = join(home, ".claude");
    await mkdir(claudeHome, { recursive: true });
    // Never clobbers a real (non-symlink) entry, only possible outside the container; refusals report together.
    const refused: string[] = [];
    for (const name of SESSION_STATE) {
        const target = join(store, name);
        const link = join(claudeHome, name);
        await mkdir(target, { recursive: true });
        const existing = await lstat(link).catch(() => undefined);
        if (existing !== undefined && !existing.isSymbolicLink()) {
            refused.push(name);
            continue;
        }
        if (existing !== undefined) {
            if ((await readlink(link)) === target) {
                continue;
            }
            await rm(link);
        }
        await symlink(target, link);
    }
    if (refused.length > 0) {
        throw new Error(`${refused.join(", ")} under ${claudeHome} exist and are not symlinks: leaving those local stores alone`);
    }
    // Only after every store is ours; a refusal means a dev host's own ~/.claude, not to be touched.
    await persistRetention(claudeHome);
};

// Resolves a `~/.claude/...` path the CLI wrote back to its workspace file, so a tool card has something openable
// instead of an unreachable home path. Root-relative since `.intentic` is shared across isolated turns; only linked
// names resolve.
// A fenced conversation's file is not at the path this returns — its store is bound over that one for the length of
// its turn — and nothing in the workspace view would open it anyway, since `.intentic` is in nobody's areas.
export const claudeStatePath = (raw: string, home = homedir()): string | undefined => {
    const prefix = `${join(home, ".claude")}/`;
    if (!raw.startsWith(prefix)) {
        return undefined;
    }
    const [name, ...tail] = raw.slice(prefix.length).split("/");
    if (name === undefined || tail.length === 0 || !SESSION_STATE.includes(name)) {
        return undefined;
    }
    return stateRelPath(".intentic/records/sessions/claude/", name, ...tail);
};
