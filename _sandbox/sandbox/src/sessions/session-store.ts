import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { statePath, stateRelPath } from "../workspace/layout/state-paths.js";

// Per-conversation state to symlink onto the workspace; settings and skills stay container-local on purpose.
const SESSION_STATE = ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"];

// Effectively "never": the CLI's sweep would now delete real transcripts (0 is rejected by the CLI).
const RETENTION_DAYS = 3650;

// Merges one key into settings.json rather than replacing it, since the user's own settings load from the same file.
// Unparseable JSON propagates rather than being clobbered; losing user settings costs more than the sweep this key
// prevents.
const persistRetention = async (claudeHome: string): Promise<void> => {
    const path = join(claudeHome, "settings.json");
    const raw = await readFile(path, "utf8").catch(() => undefined);
    const settings: { cleanupPeriodDays?: number } & Record<string, unknown> = raw === undefined ? {} : JSON.parse(raw);
    if (settings.cleanupPeriodDays === RETENTION_DAYS) {
        return;
    }
    await writeFile(path, `${JSON.stringify({ ...settings, cleanupPeriodDays: RETENTION_DAYS }, undefined, 2)}\n`);
};

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
