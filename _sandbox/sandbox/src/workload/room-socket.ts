import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { COST_BYTES, needBytes, ROOM_SOCKET, type RoomWorkload } from "@intentic/constants/memory-room";
import type { Logger } from "pino";
import type { ResourceBudget } from "./resource-budget.js";

// The budget's verdict for the scripts that start heavy work outside a turn (bin/queue-run, through `memory-room`;
// _tools/scripts/verify/test-workers.mjs), on a Unix socket of its own: never the daemon's socket, which the front
// relays to the internet. `GET /room?class=toolchain&wait=120&label=…` admits one more of that class, holding the
// answer up to `wait` seconds for room; `GET /snapshot` is the reading and what admitted work holds, for a caller that
// sizes itself to the free memory without asking to start anything.

const MAX_WAIT_SECONDS = 30 * 60;

const isWorkload = (value: string | null): value is RoomWorkload => value !== null && Object.hasOwn(COST_BYTES, value);

export interface RoomSocket {
    readonly close: () => Promise<void>;
}

export const createRoomServer = (budget: ResourceBudget): Server =>
    createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://room");
        const answer = (status: number, body: unknown): void => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
        };
        if (request.method !== "GET") {
            answer(405, { error: "GET only" });
            return;
        }
        void (async () => {
            if (url.pathname === "/snapshot") {
                answer(200, await budget.snapshot());
                return;
            }
            if (url.pathname !== "/room") {
                answer(404, { error: "GET /room or /snapshot" });
                return;
            }
            const workload = url.searchParams.get("class");
            if (!isWorkload(workload)) {
                answer(400, { error: `class is one of ${Object.keys(COST_BYTES).join(", ")}` });
                return;
            }
            const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get("wait")) || 0));
            // A caller that hangs up stops holding its place in the wait.
            const gone = new AbortController();
            response.on("close", () => {
                if (!response.writableFinished) {
                    gone.abort();
                }
            });
            const admission = await budget.admit({
                workload,
                attended: false,
                where: "local",
                ...(waitSeconds > 0 ? { wait: { deadlineMs: waitSeconds * 1000, signal: gone.signal } } : {}),
            });
            const snapshot = await budget.snapshot();
            answer(200, {
                verdict: admission.verdict,
                waitedMs: admission.waitedMs,
                needBytes: needBytes(workload, false),
                freeBytes: snapshot.freeBytes,
                reservedBytes: snapshot.reservedBytes,
                ...(admission.verdict === "run" ? {} : { diagnosis: admission.message }),
            });
        })().catch((error: unknown) => answer(500, { error: error instanceof Error ? error.message : String(error) }));
    });

/** Serves the budget on `path`; a sandbox without /run/intentic (a dev daemon on a laptop) goes without, and says so. */
export const startRoomSocket = async (budget: ResourceBudget, logger: Pick<Logger, "warn">, path: string = ROOM_SOCKET): Promise<RoomSocket> => {
    const server = createRoomServer(budget);
    // A previous daemon's socket file outlives it and would refuse the bind.
    await unlink(path)
        // allow(silent-catch): no socket file left behind is the ordinary case, and anything else the bind below reports
        .catch(() => undefined);
    const listening = await new Promise<boolean>((resolve) => {
        server.once("error", (error) => {
            logger.warn({ err: error, path }, "the room socket could not open; heavy commands judge memory by the formula alone");
            resolve(false);
        });
        server.listen(path, () => resolve(true));
    });
    return {
        close: () =>
            listening
                ? new Promise((resolve) => {
                      server.close(() => resolve());
                  })
                : Promise.resolve(),
    };
};
