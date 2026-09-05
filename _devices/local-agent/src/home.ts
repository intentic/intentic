import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/* WHERE A LOCAL AGENT KEEPS ITS STATE, and the permissions that state is written with.
 *
 * Every intentic CLI that runs on the user's own machine persists under `~/.intentic/<name>`, the sandbox it is
 * enrolled with, the credential that enrollment minted, and whatever else that agent needs. The directory layout
 * is a convention worth having in one place, but the PERMISSIONS are the reason this module exists.
 *
 * These files hold durable credentials to somebody's sandbox. `~/.intentic/host/config.json` carries an
 * enrollment token; `~/.intentic/sync/config.json` carries a sync token and sits beside an SSH private key.
 * Written with the process umask they land world-readable on a shared machine, which is a weaker boundary than
 * the grant they protect, and that is not hypothetical: the sync agent wrote its token file with default
 * permissions for its whole life, because its config module was copied from a sibling BEFORE that sibling was
 * tightened, and nothing afterwards compared the two. One writer, one floor, no second copy to forget. */

// Where a command writes its user-facing progress. Every entry point owns its sink, stdout for an interactive
// command, an append-only log file for a detached loop, so the code underneath takes one of these rather than
// writing anywhere itself.
export type Log = (message: string) => void;

export interface AgentHome {
    // `~/.intentic/<name>`. Agent-specific files (a keypair, an audit log, a pidfile) join onto this.
    readonly dir: string;
    // `<dir>/config.json`, what setup writes and every other command reads back.
    readonly configPath: string;
}

export const agentHome = (name: string): AgentHome => {
    const dir = join(homedir(), ".intentic", name);
    return { dir, configPath: join(dir, "config.json") };
};

/* Write a file only this user can read, creating its agent home the same way.
 *
 * 0700 on the directory as well as 0600 on the file: a mode on the file alone still leaves the NAMES readable,
 * and on an agent whose home holds one file per enrolled thing, the listing is itself information. Both are
 * applied on every write rather than at install time, because `mkdir` does not tighten a directory that already
 * exists, an agent installed before this floor existed would otherwise keep its old permissions forever. */
export const writeSecretFile = async (path: string, dir: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
};
