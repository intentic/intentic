// (2026-11-19, the shinobi-society audit) THE FLOOR UNDER A HELD HEAVY COMMAND. memory-room used to start a held command
// at its deadline whatever was free, and "[memory-room] … still short of memory after 120s (0.1 GiB free) — starting
// anyway" was followed by the memory guard's SIGKILL: it killed 12 processes in 8 of 14 build sessions read closely
// (one `cargo check --workspace` pulled in a C++ build whose cc1plus was killed five times in four minutes). A command
// that starts into nothing takes a person's turn's room with it and is killed anyway.
//
// So a held command never starts while less than START_FLOOR_BYTES is free, the room a person's turn needs: it goes on
// waiting, saying what is short and what holds the memory, up to its ceiling, and then gives up without starting (exit
// 75, EX_TEMPFAIL: "not run", never "failed"). Above the floor, short of what it asks for, it still starts at its deadline
// as before; a command whose parallelism the queue sets (cargo, heavy-launch.cjs) then sizes its jobs to what is free.
import { readdirSync, readFileSync } from "node:fs";
import { peakWords, pricedWords } from "./command-peaks.mjs";

const GIB = 1024 ** 3;
// The room a person's turn needs (memory-room.mjs PERSON_RESERVE_BYTES, its tests hold the two equal). Not imported:
// memory-room imports this module, and runs as a command under a top-level await that an import cycle would deadlock.
export const START_FLOOR_BYTES = GIB;
// The longest one ask holds a command before it is told again what is short, and the least, so a daemon or a formula
// that answers at once is not asked in a loop.
const ROUND_SECONDS = 60;
const MIN_ROUND_MS = 5_000;

const gib = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;
const minutes = (ms) => {
    const seconds = Math.round(ms / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
};

/** Whether an answer that did not admit the command leaves less than the floor free; an unmeasured sandbox never does. */
export const belowFloor = (answer) => answer.verdict !== "run" && answer.freeBytes !== undefined && answer.freeBytes < START_FLOOR_BYTES;

const read = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a process that exited between the listing and the read has nothing left to say
        return undefined;
    }
};

/** The processes holding the most memory now, largest first: name, pid, resident bytes, and the conversation it is for. */
export const biggestProcesses = (count = 3, proc = "/proc") => {
    let pids = [];
    try {
        pids = readdirSync(proc).filter((entry) => /^\d+$/u.test(entry));
    } catch {
        // allow(silent-catch): no procfs (not Linux) names nobody
        return [];
    }
    return pids
        .flatMap((pid) => {
            const status = read(`${proc}/${pid}/status`) ?? "";
            const kib = Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1] ?? Number.NaN);
            if (!Number.isFinite(kib)) {
                return [];
            }
            const owner = /(?:^|\0)INTENTIC_TURN_OWNER=([^\0]*)/u.exec(read(`${proc}/${pid}/environ`) ?? "")?.[1];
            return [{ pid: Number(pid), name: /^Name:\s+(.*)$/mu.exec(status)?.[1] ?? "?", bytes: kib * 1024, owner: owner === "" ? undefined : owner }];
        })
        .toSorted((left, right) => right.bytes - left.bytes)
        .slice(0, count);
};

const biggestWords = (biggest) =>
    biggest.length === 0
        ? ""
        : ` Holding the most now: ${biggest.map((entry) => `${entry.name} (pid ${entry.pid}, ${gib(entry.bytes)}${entry.owner === undefined ? "" : `, conversation ${entry.owner}`})`).join(", ")}.`;

/** What a command held below the floor is told, each round: what is short, what holds the memory, and what to do. */
export const floorWords = (label, answer, { waitedMs, ceilingMs, biggest = [] }) => {
    const still = answer.diagnosis === undefined ? "" : ` (${answer.diagnosis})`;
    const priced = answer.priced === undefined ? "" : `, since ${peakWords(answer.priced)}`;
    return (
        `[memory-room] ${label}: holding it: ${gib(answer.freeBytes ?? 0)} free${still}, under the ${gib(START_FLOOR_BYTES)} a heavy command needs to start ` +
        `without being killed (it asks for ${gib(answer.needBytes ?? 0)}${priced}). It starts by itself once there is room, and gives up without starting in ` +
        `${minutes(Math.max(0, ceilingMs - waitedMs))}.${biggestWords(biggest)} To make room: stop a background job or server you started, ` +
        "or send this to one of the owner's machines with `remote-run -- <command>` if one is connected."
    );
};

/**
 * What `memory-room` prints for a command it held, or undefined for one it never held. Says why it waited (`waitedFor`,
 * the first short reading's diagnosis), for one that starts short of room (never below the floor) why it starts anyway,
 * and for one priced by what it took on earlier runs rather than by its rule (command-peaks.mjs), that price and why.
 */
export const waitWords = (label, answer) => {
    if (!(answer.waitedMs > 0)) {
        return undefined;
    }
    const seconds = Math.round(answer.waitedMs / 1000);
    const free = answer.freeBytes === undefined ? "?" : gib(answer.freeBytes);
    const why = answer.waitedFor ?? answer.diagnosis;
    const held = why === undefined ? "" : ` (${why})`;
    const priced = pricedWords(answer.priced);
    if (answer.verdict === "run") {
        return `[memory-room] ${label}: waited ${seconds}s for memory${held}, ${free} free — starting.${priced}`;
    }
    const still = answer.diagnosis === undefined ? "" : ` Still: ${answer.diagnosis}.`;
    return answer.stuck === true
        ? `[memory-room] ${label}: short of memory for ${seconds}s, and waiting longer would not help: nothing admitted is about to let memory go and the shortage has not eased (${free} free) — starting now.${still}${priced}`
        : `[memory-room] ${label}: still short of memory after ${seconds}s (${free} free, above the ${gib(START_FLOOR_BYTES)} floor it needs to start) — starting with what there is.${still}${priced}`;
};

/** What a command held to its ceiling below the floor is told as it gives up. */
export const notStartedWords = (label, answer, waitedMs) =>
    `[memory-room] ${label}: not started: after ${minutes(waitedMs)} the sandbox still had ${gib(answer.freeBytes ?? 0)} free, under the ` +
    `${gib(START_FLOOR_BYTES)} a heavy command needs to start without being killed${answer.diagnosis === undefined ? "" : ` (${answer.diagnosis})`}. ` +
    "Run it again once memory is free.";

/**
 * Holds a command whose first wait ended below the floor (belowFloor) until it is not, asking again with `ask(seconds)`
 * a round at a time, up to `ceilingSeconds` from `startedAt`. The answer it ends on, with `waitedMs` from `startedAt`,
 * the first wait's `waitedFor`, and `notStarted` when it is still below the floor at the ceiling.
 */
export const holdAtFloor = async ({ answer, ask, label, ceilingSeconds, say, startedAt, now = Date.now, biggest = biggestProcesses, sleep }) => {
    const ceilingMs = Math.max(0, ceilingSeconds) * 1000;
    const pause = sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    let current = answer;
    while (belowFloor(current) && now() - startedAt < ceilingMs) {
        say(floorWords(label, current, { waitedMs: now() - startedAt, ceilingMs, biggest: biggest() }));
        const round = Math.max(1, Math.min(ROUND_SECONDS, Math.ceil((ceilingMs - (now() - startedAt)) / 1000)));
        const askedAt = now();
        current = await ask(round);
        if (now() - askedAt < MIN_ROUND_MS && belowFloor(current)) {
            await pause(MIN_ROUND_MS);
        }
    }
    const ended = { ...current, waitedMs: now() - startedAt };
    if (answer.waitedFor !== undefined) {
        ended.waitedFor = answer.waitedFor;
    }
    if (belowFloor(current)) {
        ended.notStarted = true;
    }
    return ended;
};
