import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The Claude Agent SDK keeps its per-conversation state under ~/.claude — the container's ephemeral fs, wiped
// on every rebuild while /work survives. Point every conversation-owned store at the workspace volume before
// the first turn can spawn the CLI, so a rebuild keeps a session WHOLE: its transcript, its plan-mode plans,
// its pre-edit backups, its background-task outputs, its todos — not just the prose. Mirrors .intentic/codex
// (CODEX_HOME), which is why Codex threads always survived rebuilds and Claude chats didn't.
//
// Symlinks, not CLAUDE_CONFIG_DIR: relocating the whole config dir would orphan the image-baked
// /root/.claude/skills and the user settings loaded via settingSources:["user"], and the daemon's own
// listSessions/getSessionInfo reads resolve the store from the daemon's process env — a per-turn env
// override would split the CLI's write store from the daemon's read store.
//
// What is NOT here is deliberate: skills and plugins are image-baked, CLAUDE.md/RTK.md are boot-written by the
// daemon, and policy/settings caches regenerate — container-local is their correct home. settings.json stays
// container-local for that reason too; the daemon just rewrites its one retention key on every boot (below).
const SESSION_STATE = ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"];

// The CLI sweeps transcripts older than `cleanupPeriodDays` (default 30) on startup. That sweep was harmless
// while the store was ephemeral — a rebuild beat it to them either way — but linking the store onto /work
// makes it the ONLY thing that deletes a transcript. Left at the default it would take an archived agent's
// history a month on while its card stayed on the board: the same orphaning the links just fixed, on a slower
// clock. So the window is part of taking the store over, not a preference, and it is written right beside them.
//
// A long window rather than "off": the CLI rejects 0 (it used to silently disable transcript writes altogether),
// so ~10 years is how the setting spells "keep them". The real off switch is --no-session-persistence.
const RETENTION_DAYS = 3650;

// Merged into ~/.claude/settings.json, never replacing it: that is the user settings file settingSources:
// ["user"] loads, so the daemon owns one key in a file the user also owns. Unparseable JSON propagates rather
// than being clobbered — losing the user's settings would cost more than the sweep this prevents.
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
    const store = join(workspaceRoot, ".intentic", "claude");
    const claudeHome = join(home, ".claude");
    await mkdir(claudeHome, { recursive: true });
    // A real (non-symlink) entry only happens outside the container (a dev-host run) — never clobber real
    // session data. Converge every other entry first, then report the refusals in one throw.
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
        throw new Error(`${refused.join(", ")} under ${claudeHome} exist and are not symlinks — leaving those local stores alone`);
    }
    // Only once every store IS ours. A refusal means someone else's ~/.claude (a dev-host run), and rewriting
    // the retention of a store we didn't take over would be editing the developer's own settings.
    await persistRetention(claudeHome);
};
