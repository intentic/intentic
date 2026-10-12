import { logsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createClientBudget, type ClientBudgetOptions } from "./client-budget.js";
import { listLogFiles, logsRoot, tailLogFile } from "./log-files.js";

export type LogsRoutesDeps = Pick<Services, "config" | "clientLogger">;

// A page's own pace is a batch of at most 50 every five seconds, and its reporter folds repeats into counts, so a
// healthy tab writes a few lines a minute; 120 leaves a real burst room and stops a broken one long before the file's
// size cap would. The shared ceiling covers a page that mints a new id per batch.
const CLIENT_BUDGET: ClientBudgetOptions = { perKeyPerWindow: 120, allPerWindow: 600, windowMs: 60_000 };

// Read-only reads over historyRoot/logs (terminal captures, run logs, daemon.log, resource-metrics.jsonl); only the
// daemon/tmux write those files. `report` below is this router's one write, into its own file.
export const createLogsRoutes = (services: LogsRoutesDeps, options: { budget?: ClientBudgetOptions } = {}) => {
    const i = implement(logsContract).$context<OrpcContext>();
    const root = logsRoot(services.config.historyRoot);
    const budget = createClientBudget(options.budget ?? CLIENT_BUDGET);
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
        // `report` so they cannot overwrite `time`/`level`/`message`. `time` is the daemon's receive stamp, `seenAt` the
        // browser's. The page stamp rides on every line rather than once, since a reader filters lines one at a time (a
        // page id, a replay id) and a line without it could not be told apart. No sink returns recorded: 0 instead of
        // throwing.
        report: i.report.handler(({ input }) => {
            const logger = services.clientLogger;
            if (logger === undefined) {
                return { recorded: 0 };
            }
            const page = input.page;
            // A page from before the stamp shares one budget with every other such page.
            const { allowed, refusedEarlier } = budget.take(page?.pageId ?? "unstamped", input.events.length);
            if (refusedEarlier > 0) {
                logger.warn(
                    { client: true, event: "client.throttled", page, report: { refused: refusedEarlier } },
                    `the daemon refused ${refusedEarlier} reports from this page over its per-minute limit`,
                );
            }
            for (const event of input.events.slice(0, allowed)) {
                logger[event.level](
                    {
                        client: true,
                        event: event.event,
                        seenAt: event.seenAt,
                        // Absent from a page older than the stamp; pino leaves an undefined key out of the line.
                        page,
                        report: { ...event.fields, route: event.route, requestId: event.requestId, build: event.build },
                    },
                    event.message,
                );
            }
            return { recorded: allowed };
        }),
    };
};
