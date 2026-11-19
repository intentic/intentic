import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { errorMessage } from "@intentic/base/errors";
import { COST_BYTES, isRoomSize, needBytes, ROOM_SOCKET, type RoomSize, type RoomWorkload } from "@intentic/constants/memory-room";
import type { Logger } from "pino";
import type { PerfTracker } from "../system/resources/perf.js";
import type { Admission, ResourceBudget } from "./resource-budget.js";

// The budget's verdict for the scripts that start heavy work outside a turn (bin/queue-run, through `memory-room`;
// _tools/scripts/verify/test-workers.mjs), on a Unix socket of its own: never the daemon's socket, which netd
// relays to the internet. `GET /room?class=toolchain&wait=120&label=…` admits one more of that class, holding the
// answer up to `wait` seconds for room; `size=<name>` prices a toolchain command by a shape SIZE_BYTES names
// (`targeted`, `editor-typecheck`, `scoped-typecheck`) or a MiB count (`6144m`, a project's declared class) instead of
// its class, any other name being the class, and
// `pid=N` names the process the work runs as, whose exit hands its reservation back; `GET /snapshot` is the reading and what admitted work holds, for a caller that
// sizes itself to the free memory without asking to start anything.

const MAX_WAIT_SECONDS = 30 * 60;

const isWorkload = (value: string | null): value is RoomWorkload => value !== null && Object.hasOwn(COST_BYTES, value);

export interface RoomSocket {
    readonly close: () => Promise<void>;
}

// What the room socket answers: the budget's verdict and the sandbox's room after it.
interface RoomReply {
    readonly verdict: Admission["verdict"];
    readonly waitedMs: number;
    readonly needBytes: number;
    readonly freeBytes: number | undefined;
    readonly reservedBytes: number;
    diagnosis?: string;
    waitedFor?: string;
    stuck?: true;
}

// One `/room` request admitted. Why it waited, from its first short reading, is said with the answer however the wait
// ends (2026-11-17, the shinobi-society audit: a wait that ended in room said nothing of why it was held, one that ended
// short said only how much was free). Every caller here starts its command when the answer comes, so a wait that cannot
// help is given up rather than sat out to its deadline (`giveUpWhenStuck`).
const admitAsked = async (
    budget: ResourceBudget,
    workload: RoomWorkload,
    params: URLSearchParams,
    signal: AbortSignal,
    perf: Pick<PerfTracker, "record"> | undefined,
): Promise<RoomReply> => {
    const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(params.get("wait")) || 0));
    const asked = params.get("size") ?? "";
    const size: RoomSize | undefined = isRoomSize(asked) ? asked : undefined;
    const pid = Number(params.get("pid"));
    let waitedFor: string | undefined;
    const wait = {
        deadlineMs: waitSeconds * 1000,
        signal,
        giveUpWhenStuck: true,
        onShort: (diagnosis: string) => {
            waitedFor = diagnosis;
        },
    };
    const admission = await budget.admit({
        workload,
        attended: false,
        where: "local",
        size,
        pid: Number.isInteger(pid) && pid > 1 ? pid : undefined,
        ...(waitSeconds > 0 ? { wait } : {}),
    });
    const snapshot = await budget.snapshot();
    const stuck = admission.verdict === "refuse" && admission.stuck === true;
    perf?.record("room.admit", admission.waitedMs, {
        class: workload,
        size,
        verdict: admission.verdict,
        stuck,
        waitedFor,
        label: params.get("label") ?? undefined,
        freeBytes: snapshot.freeBytes,
        reservedBytes: snapshot.reservedBytes,
    });
    const reply: RoomReply = {
        verdict: admission.verdict,
        waitedMs: admission.waitedMs,
        needBytes: needBytes(workload, false, size),
        freeBytes: snapshot.freeBytes,
        reservedBytes: snapshot.reservedBytes,
    };
    if (admission.verdict === "refuse") {
        // The bare reason where the hold has one: the sentence a held admission carries says the work "did not start",
        // which `memory-room`'s caller does anyway.
        reply.diagnosis = admission.diagnosis ?? admission.message;
    } else if (admission.verdict === "wait") {
        reply.diagnosis = admission.message;
    }
    if (waitedFor !== undefined) {
        reply.waitedFor = waitedFor;
    }
    if (stuck) {
        reply.stuck = true;
    }
    return reply;
};

// Each admission's wait goes to perf.jsonl as `room.admit` once it is slow: the gate held heavy commands 17 hours in one
// week (2026-09-26..10-02) and nothing the daemon logged showed it.
export const createRoomServer = (budget: ResourceBudget, perf?: Pick<PerfTracker, "record">): Server =>
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
            // A caller that hangs up stops holding its place in the wait.
            const gone = new AbortController();
            response.on("close", () => {
                if (!response.writableFinished) {
                    gone.abort();
                }
            });
            answer(200, await admitAsked(budget, workload, url.searchParams, gone.signal, perf));
        })().catch((error: unknown) => answer(500, { error: errorMessage(error) }));
    });

/** Serves the budget on `path`; a sandbox without /run/intentic (a dev daemon on a laptop) goes without, and says so. */
export const startRoomSocket = async (
    budget: ResourceBudget,
    logger: Pick<Logger, "warn">,
    path: string = ROOM_SOCKET,
    perf?: Pick<PerfTracker, "record">,
): Promise<RoomSocket> => {
    const server = createRoomServer(budget, perf);
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
