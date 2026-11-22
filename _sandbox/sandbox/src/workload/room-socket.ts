import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { errorMessage } from "@intentic/base/errors";
import {
    COST_BYTES,
    costBytesOf,
    isRoomSize,
    type LearnedPrice,
    learnedCostBytes,
    needBytes,
    ROOM_SOCKET,
    type RoomSize,
    type RoomWorkload,
} from "@intentic/constants/memory-room";
import type { Logger } from "pino";
import type { PerfTracker } from "../system/resources/perf.js";
import type { Admission, BudgetSnapshot, ResourceBudget } from "./resource-budget.js";

// The budget's verdict for the scripts that start heavy work outside a turn (bin/queue-run, through `memory-room`;
// _tools/scripts/verify/test-workers.mjs), on a Unix socket of its own: never the daemon's socket, which netd
// relays to the internet. `GET /room?class=toolchain&wait=120&label=…` admits one more of that class, holding the
// answer up to `wait` seconds for room; `size=<name>` prices a toolchain command by a shape SIZE_BYTES names
// (`targeted`, `editor-typecheck`, `scoped-typecheck`) or a MiB count (`6144m`, a project's declared class) instead of
// its class, any other name being the class, and
// `pid=N` names the process the work runs as, whose exit hands its reservation back; `GET /snapshot` is the reading and what admitted work holds, for a caller that
// sizes itself to the free memory without asking to start anything. (2026-11-22) `key=…&command=…&start=N` name the
// command a queued process runs and that process's start (@intentic/constants heavy/command-peaks.mjs): a toolchain
// command is then priced at least at what it took at its peak lately, with a margin (memory-room `learnedCostBytes`), the
// answer says so (`priced`), and this run is measured for the next.

const MAX_WAIT_SECONDS = 30 * 60;
const MIB = 1024 ** 2;
// Longer than this, a key or a command is not one memory-room sends.
const MAX_SIGNATURE_CHARS = 600;

// What the gate knows of each command's measured peaks, and how it measures one (system/resources/queue/command-peaks.ts).
export interface CommandPeaks {
    readonly learned: (key: string) => Promise<{ readonly command: string; readonly peakBytes: number; readonly runs: number } | undefined>;
    // The pid this daemon sees for the process memory-room named from its own pid namespace, by its start.
    readonly resolve: (pid: number, startTicks: number) => Promise<number | undefined>;
    readonly watch: (pid: number, key: string, command: string) => Promise<void>;
    // Ends every measurement, as the socket closes.
    readonly stop: () => void;
}

interface Signature {
    readonly key: string;
    readonly command: string;
    readonly start: number;
}

const signatureOf = (params: URLSearchParams): Signature | undefined => {
    const key = params.get("key") ?? "";
    const command = params.get("command") ?? "";
    const start = Number(params.get("start") ?? Number.NaN);
    const fits = (text: string): boolean => text !== "" && text.length <= MAX_SIGNATURE_CHARS;
    return fits(key) && fits(command) && Number.isSafeInteger(start) && start >= 0 ? { key, command, start } : undefined;
};

// The price a toolchain command is admitted at, as the size the budget reads: its rule's, or what it took at its peak
// lately with the margin where that is more, in MiB, with why. A command never measured, or measured lighter, keeps its
// rule's size. Capped at the sandbox's limit, so a measured outlier only waits, as any large command does.
const learnedSize = async (
    budget: ResourceBudget,
    peaks: CommandPeaks | undefined,
    workload: RoomWorkload,
    size: RoomSize | undefined,
    signature: Signature | undefined,
): Promise<{ readonly size: RoomSize | undefined; readonly priced?: LearnedPrice }> => {
    if (peaks === undefined || signature === undefined || workload !== "toolchain") {
        return { size };
    }
    // allow(silent-catch): peaks that cannot be read price the command as if it was never measured
    const learned = await peaks.learned(signature.key).catch(() => undefined);
    if (learned === undefined) {
        return { size };
    }
    const configured = costBytesOf(workload, size);
    const bytes = learnedCostBytes(configured, learned.peakBytes, (await budget.snapshot()).reading.limitBytes);
    if (bytes <= configured) {
        return { size };
    }
    const mib = Math.ceil(bytes / MIB);
    return { size: `${mib}m`, priced: { bytes: mib * MIB, peakBytes: learned.peakBytes, runs: learned.runs, command: learned.command } };
};

// The process memory-room named, as this daemon sees it; undefined where it cannot be found (or nothing names it).
const seenPid = async (peaks: CommandPeaks | undefined, pid: number | undefined, signature: Signature | undefined): Promise<number | undefined> =>
    peaks === undefined || pid === undefined || signature === undefined
        ? undefined
        // allow(silent-catch): a process that cannot be found is not measured; its admission is unchanged
        : await peaks.resolve(pid, signature.start).catch(() => undefined);

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
    // What the command is priced at, and why where that is its measured peak (`learnedSize`).
    readonly costBytes: number;
    priced?: LearnedPrice;
    diagnosis?: string;
    waitedFor?: string;
    stuck?: true;
}

// What one `/room` request asks for: the size it is priced at (and why, where that is a measured peak), the process it
// runs as (as this daemon sees it, where found), and the run to measure, where its process is found.
interface Asked {
    readonly size: RoomSize | undefined;
    readonly priced: LearnedPrice | undefined;
    readonly pid: number | undefined;
    readonly measure: (Signature & { readonly pid: number }) | undefined;
}

const askedOf = async (budget: ResourceBudget, workload: RoomWorkload, params: URLSearchParams, peaks: CommandPeaks | undefined): Promise<Asked> => {
    const named = params.get("size") ?? "";
    const signature = signatureOf(params);
    const { size, priced } = await learnedSize(budget, peaks, workload, isRoomSize(named) ? named : undefined, signature);
    const number = Number(params.get("pid"));
    const pid = Number.isInteger(number) && number > 1 ? number : undefined;
    // Found by its start, the reservation is handed back when that very process exits, even from a pid namespace of its own.
    const seen = await seenPid(peaks, pid, signature);
    return { size, priced, pid: seen ?? pid, measure: seen === undefined || signature === undefined ? undefined : { ...signature, pid: seen } };
};

// What one admission is answered: the verdict, the room after it, the price, and why it waited or is still short.
const replyOf = (admission: Admission, workload: RoomWorkload, asked: Asked, snapshot: BudgetSnapshot, waitedFor: string | undefined): RoomReply => {
    const reply: RoomReply = {
        verdict: admission.verdict,
        waitedMs: admission.waitedMs,
        needBytes: needBytes(workload, false, asked.size),
        freeBytes: snapshot.freeBytes,
        reservedBytes: snapshot.reservedBytes,
        costBytes: costBytesOf(workload, asked.size),
    };
    if (asked.priced !== undefined) {
        reply.priced = asked.priced;
    }
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
    if (admission.verdict === "refuse" && admission.stuck === true) {
        reply.stuck = true;
    }
    return reply;
};

// One `/room` request admitted. Why it waited, from its first short reading, is said with the answer however the wait
// ends (2026-11-17, the shinobi-society audit: a wait that ended in room said nothing of why it was held, one that ended
// short said only how much was free). Every caller here starts its command when the answer comes, so a wait that cannot
// help is given up rather than sat out to its deadline (`giveUpWhenStuck`): except for a command priced by what it was
// measured to take, which is known to be killed if it starts short. 2026-11-20, shinobi-society: `cargo test -p
// integra-render` was started 30 s into its wait, "waiting longer would not help", and its 8.8–10.8 GiB test binary was
// killed by the memory guard three times in eighteen minutes; it waits out its deadline for room instead.
const admitAsked = async (
    budget: ResourceBudget,
    workload: RoomWorkload,
    params: URLSearchParams,
    signal: AbortSignal,
    { perf, peaks }: RoomServices,
): Promise<RoomReply> => {
    const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(params.get("wait")) || 0));
    const asked = await askedOf(budget, workload, params, peaks);
    let waitedFor: string | undefined;
    const wait = {
        deadlineMs: waitSeconds * 1000,
        signal,
        giveUpWhenStuck: asked.priced === undefined,
        onShort: (diagnosis: string) => {
            waitedFor = diagnosis;
        },
    };
    const admission = await budget.admit({
        workload,
        attended: false,
        where: "local",
        size: asked.size,
        pid: asked.pid,
        ...(waitSeconds > 0 ? { wait } : {}),
    });
    if (asked.measure !== undefined) {
        // Before the answer, while the process is still queue-run: the measurement starts at its exec into the command.
        // allow(silent-catch): a run that cannot be watched is not measured; the command starts as answered
        await peaks?.watch(asked.measure.pid, asked.measure.key, asked.measure.command).catch(() => undefined);
    }
    const snapshot = await budget.snapshot();
    perf?.record("room.admit", admission.waitedMs, {
        class: workload,
        size: asked.size,
        verdict: admission.verdict,
        stuck: admission.verdict === "refuse" && admission.stuck === true,
        waitedFor,
        label: params.get("label") ?? undefined,
        freeBytes: snapshot.freeBytes,
        reservedBytes: snapshot.reservedBytes,
        pricedBytes: asked.priced?.bytes,
    });
    return replyOf(admission, workload, asked, snapshot, waitedFor);
};

// What the room socket answers with besides the budget: where slow admissions are logged, and the measured peaks.
export interface RoomServices {
    readonly perf?: Pick<PerfTracker, "record"> | undefined;
    readonly peaks?: CommandPeaks | undefined;
}

// Each admission's wait goes to perf.jsonl as `room.admit` once it is slow: the gate held heavy commands 17 hours in one
// week (2026-09-26..10-02) and nothing the daemon logged showed it.
export const createRoomServer = (budget: ResourceBudget, services: RoomServices = {}): Server =>
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
            answer(200, await admitAsked(budget, workload, url.searchParams, gone.signal, services));
        })().catch((error: unknown) => answer(500, { error: errorMessage(error) }));
    });

/** Serves the budget on `path`; a sandbox without /run/intentic (a dev daemon on a laptop) goes without, and says so. */
export const startRoomSocket = async (
    budget: ResourceBudget,
    logger: Pick<Logger, "warn">,
    { path = ROOM_SOCKET, ...services }: RoomServices & { readonly path?: string } = {},
): Promise<RoomSocket> => {
    const server = createRoomServer(budget, services);
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
        close: () => {
            services.peaks?.stop();
            return listening
                ? new Promise((resolve) => {
                      server.close(() => resolve());
                  })
                : Promise.resolve();
        },
    };
};
