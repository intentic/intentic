import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { extensionRuntimeDir, STATE_DIR, WORKSPACE_ROOT } from "@intentic/sandbox-contract";

/* WHERE THIS EXTENSION KEEPS ITS SCRATCH STATE, one hour of cached access token per connection, and the
 * watcher's resume marks.
 *
 * The watcher is handed `INTENTIC_WORKSPACE` by the daemon; `gw` is not, it is spawned by the agent's shell,
 * which only has a cwd. Walking up for the state dir is what makes both land in the same place, including
 * from an isolated turn's worktree, where the constant would be wrong. The constant is the last resort rather
 * than the first, for exactly that reason. */

const EXTENSION = "google-workspace";

export const workspaceRoot = (env: NodeJS.ProcessEnv, cwd: string): string => {
    const declared = env["INTENTIC_WORKSPACE"];
    if (declared !== undefined && declared !== "") {
        return declared;
    }
    let dir = cwd;
    for (;;) {
        if (existsSync(join(dir, STATE_DIR))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return env["WORKSPACE_ROOT"] ?? WORKSPACE_ROOT;
        }
        dir = parent;
    }
};

// A connection's own directory under the runtime tree. `name` is an env suffix lowercased, so it is already
// slug-shaped; the replace is defence in depth against a path ever being built from something else.
export const runtimeDir = (root: string, name: string): string =>
    join(root, extensionRuntimeDir(EXTENSION), name.replaceAll(/[^a-zA-Z0-9._-]/g, "_"));
