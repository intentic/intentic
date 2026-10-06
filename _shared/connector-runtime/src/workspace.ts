import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { extensionGatewayUrlFile } from "@intentic/sandbox-contract/workspace-state";

// Where an agent-side CLI finds the workspace, and through it a gateway's control address. The agent may stand in any
// directory under the workspace (a repository, a conversation's worktree), so this walks up rather than trusting cwd.

// INTENTIC_WORKSPACE when the sandbox set it; else the nearest ancestor of `cwd` holding `probe` (workspace-relative,
// `.intentic` unless a caller needs a specific file, since a repository can carry an `.intentic` of its own); else
// WORKSPACE_ROOT.
export const findWorkspaceRoot = (env: NodeJS.ProcessEnv, cwd: string, probe: string = STATE_DIR): string => {
    const declared = env["INTENTIC_WORKSPACE"];
    if (declared !== undefined && declared !== "") {
        return declared;
    }
    for (let dir = cwd; ; dir = dirname(dir)) {
        if (existsSync(join(dir, probe))) {
            return dir;
        }
        if (dirname(dir) === dir) {
            return env["WORKSPACE_ROOT"] ?? WORKSPACE_ROOT;
        }
    }
};

// The address a running gateway published for `provider` (runConnectorGateway's `publishGatewayUrl`), or undefined
// when none is there yet, which means the gateway has not started. A file that is there and cannot be read is not that,
// so it throws rather than reading as a gateway that is down.
export const readGatewayUrl = async (provider: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<string | undefined> => {
    const file = extensionGatewayUrlFile(provider);
    const url = await readFile(join(findWorkspaceRoot(env, cwd, file), file), "utf8").catch(undefinedIfMissing);
    return url === undefined || url.trim() === "" ? undefined : url.trim();
};
