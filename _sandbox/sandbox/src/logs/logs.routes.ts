import { logsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { listLogFiles, logsRoot, tailLogFile } from "./log-files.js";

export type LogsRoutesDeps = Pick<Services, "config" | "clientLogger">;

// Read-only reads over historyRoot/logs (terminal captures, run logs, daemon.log, resource-metrics.jsonl); only the
// daemon/tmux write those files. `report` below is this router's one write, into its own file.
export const createLogsRoutes = (services: LogsRoutesDeps) => {
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
        // client: true marks a browser's self-report as distinct from the daemon's own log; incoming fields nest under
        // `report` so they cannot overwrite `time`/`level`/`message`. No sink returns recorded: 0 instead of throwing.
        report: i.report.handler(({ input }) => {
            const logger = services.clientLogger;
            if (logger === undefined) {
                return { recorded: 0 };
            }
            for (const event of input.events) {
                logger[event.level](
                    {
                        client: true,
                        event: event.event,
                        seenAt: event.seenAt,
                        report: { ...event.fields, route: event.route, requestId: event.requestId, build: event.build },
                    },
                    event.message,
                );
            }
            return { recorded: input.events.length };
        }),
    };
};
