import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The Claude Agent SDK stores chat transcripts under ~/.claude/projects — the container's ephemeral fs,
// wiped on every rebuild while /work survives, which orphaned every session id the browser still held.
// Point the store at the workspace volume before the first turn can spawn the CLI. Mirrors .intentic/codex
// (CODEX_HOME), which is why Codex threads always survived rebuilds and Claude chats didn't.
//
// A symlink, not CLAUDE_CONFIG_DIR: relocating the whole config dir would orphan the image-baked
// /root/.claude/skills and the user settings loaded via settingSources:["user"], and the daemon's own
// listSessions/getSessionInfo reads resolve the store from the daemon's process env — a per-turn env
// override would split the CLI's write store from the daemon's read store.
export const linkClaudeProjects = async (workspaceRoot: string, home = homedir()): Promise<void> => {
    const target = join(workspaceRoot, ".intentic", "claude", "projects");
    const link = join(home, ".claude", "projects");
    await mkdir(target, { recursive: true });
    await mkdir(dirname(link), { recursive: true });
    const existing = await lstat(link).catch(() => undefined);
    if (existing !== undefined && !existing.isSymbolicLink()) {
        // A real directory only happens outside the container (a dev-host run) — never clobber real transcripts.
        throw new Error(`${link} exists and is not a symlink — leaving the local session store alone`);
    }
    if (existing !== undefined) {
        if ((await readlink(link)) === target) {
            return;
        }
        await rm(link);
    }
    await symlink(target, link);
};
