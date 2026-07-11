import { logsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { listLogFiles, logsRoot, tailLogFile } from "./log-files.js";

// Daemon-owned debug logs under historyRoot/logs — terminal captures, intentic run logs, daemon.log. Read-only:
// only the daemon/tmux write these files (the same trust rationale as /activity).
export const createLogsRoutes = (services: Services) => {
    const i = implement(logsContract).$context<OrpcContext>();
    const root = logsRoot(services.config.historyRoot);
    return {
        list: i.list.handler(async () => ({ files: await listLogFiles(root) })),
        read: i.read.handler(async ({ input }) => {
            const tail = await tailLogFile(root, input.name, input.bytes);
            if (tail === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no such log" });
            }
            return { name: input.name, sizeBytes: tail.sizeBytes, text: tail.text, truncated: tail.sizeBytes > input.bytes };
        }),
    };
};
