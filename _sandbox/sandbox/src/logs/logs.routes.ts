import { logsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { listLogFiles, logsRoot, tailLogFile } from "./log-files.js";

export type LogsRoutesDeps = Pick<Services, "config" | "clientLogger">;

// Daemon-owned debug logs under historyRoot/logs, terminal captures, intentic run logs, daemon.log and the
// resource-metrics JSONL series. The reads are read-only: only the daemon/tmux write those files (the same
// trust rationale as /activity). `report` is the one write, and it lands in a file of its own, see below.
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
        /* WHAT THE BROWSER SAW, filed in client.jsonl. The only write on this router and the only record of a
         * failure nothing daemon-side can witness: a render error, a stall the user felt, a startup recovery
         * that wiped its own evidence before anyone could read it.
         *
         * Every line is stamped `client: true`. Not decoration: this file is a browser's account of itself, and
         * a reader who cannot tell that from the daemon's own account would eventually trust the wrong one. The
         * fields the client sent ride under `report` rather than at the top level for the same reason, so
         * nothing a page chooses to send can collide with `time`, `level` or `message` and rewrite the frame
         * the daemon put around it.
         *
         * `error` and `warn` are carried through as the client set them, because the browser has already
         * decided what is worth a round trip; the schema's caps are what stop that from being unbounded. No
         * sink (an unwritable history root, local dev) reports zero rather than throwing: a diagnostic channel
         * failing must never be the thing that breaks the page trying to report a failure. */
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
