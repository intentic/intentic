import type { TurnTools } from "../providers/agent-request.js";
import { heavyEnvVariables, QUEUE_RUN_BIN, queueRunEnabled } from "../../workload/heavy-commands.js";

// The heavy-command environment for a vendor runtime's own shell (Codex's app-server, Cursor's session), which the
// daemon never writes a line for: every program that shell starts is judged by the same table Claude Code's lines
// carry (agent/tools/agent-terminals.ts), so a build queues, and an install takes the one install lane, whichever runtime ran it.
// Nothing is offloaded from here: offload rides the line Claude Code's hook rewrites. Empty for a request that carries no
// table, or a table that cannot be read, which leaves the shell as it was.
export const vendorShellEnv = async (tools: Pick<TurnTools, "heavyCommands">, inherited: Readonly<Record<string, string | undefined>>): Promise<Record<string, string>> => {
    if (tools.heavyCommands === undefined) {
        return loginPath(inherited["PATH"]);
    }
    try {
        const heavy = heavyEnvVariables(await tools.heavyCommands(), { queueRun: queueRunEnabled() ? QUEUE_RUN_BIN : undefined }, inherited);
        return { ...heavy, ...loginPath(heavy["PATH"] ?? inherited["PATH"]) };
    } catch {
        // allow(silent-catch): an unreadable table leaves the vendor's shell as it was, unqueued, never fails the turn.
        return loginPath(inherited["PATH"]);
    }
};

// The PATH a login shell puts back (the image's /etc/profile.d/00-intentic-path.sh). Codex runs every command through
// `bash -lc`, and /etc/profile replaces PATH outright, so the one the daemon built here never reached a command: 67
// "pnpm: command not found" in the ten days to 2026-10-26. A variable /etc/profile leaves alone carries it past.
const loginPath = (path: string | undefined): Record<string, string> => (path === undefined || path === "" ? {} : { INTENTIC_LOGIN_PATH: path });
