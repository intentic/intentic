import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
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
// daemon, and policy/settings caches regenerate — container-local is their correct home.
const SESSION_STATE = ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"];

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
};
