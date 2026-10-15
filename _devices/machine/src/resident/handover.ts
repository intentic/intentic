import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { isProcessAlive } from "@intentic/local-agent";
import { z } from "zod";
import { baseDir } from "../config.js";
import { LINK_STAMP_MS } from "../device/config.js";

/* THE HANDOVER AT A SIGN-IN (2026-10-15; resident.ts, BEFORE ANYONE SIGNS IN). The signed-in session's agent asks the one
   the PC started before sign-in to leave by writing this file, and that one reads it every tick and ends itself the
   ordinary way: its distros, links and commands closed, its exit recorded, its pidfile released. Killing it from here
   instead would end it mid-tick with none of that done. The request carries its writer's pid and when, so one left by
   an agent that died before taking over is not obeyed by the next boot agent. */

export const handoverPath = join(baseDir, "handover.json");

// Long enough to outlast the wait below; a request older than this was abandoned.
export const HANDOVER_FRESH_MS = 60_000;
// Four of the boot agent's ticks, the most it should take to read the request and leave.
export const HANDOVER_WAIT_MS = 4 * LINK_STAMP_MS;

const HandoverSchema = z.object({ pid: z.int().positive(), at: z.number() });
type Handover = z.infer<typeof HandoverSchema>;

const readHandover = async (path: string): Promise<Handover | undefined> => {
    // allow(silent-catch): no request file is no request
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) {
        return undefined;
    }
    try {
        return HandoverSchema.safeParse(JSON.parse(raw)).data;
    } catch {
        // allow(silent-catch): a half-written request is read whole at the next tick, while its writer still waits
        return undefined;
    }
};

interface AskedOptions {
    readonly path?: string;
    readonly now?: () => number;
    readonly alive?: (pid: number) => boolean;
}

// The boot agent's question, every tick: has a live, recent agent asked for this environment?
export const handoverAsked = async ({ path = handoverPath, now = Date.now, alive = isProcessAlive }: AskedOptions = {}): Promise<boolean> => {
    const asked = await readHandover(path);
    return asked !== undefined && now() - asked.at < HANDOVER_FRESH_MS && alive(asked.pid);
};

interface AskOptions {
    // Which pid holds the environment now, or undefined once nobody does.
    readonly holderNow: () => Promise<number | undefined>;
    // Ends a holder that did not leave within the wait.
    readonly stop: (pid: number) => Promise<void>;
    readonly path?: string;
    readonly waitMs?: number;
    readonly pollMs?: number;
}

// The signed-in agent's side: ask, wait for the holder to go, and stop it only if it does not. The request is gone
// afterwards either way, so nothing later reads it.
export const askHandover = async (
    holder: number,
    { holderNow, stop, path = handoverPath, waitMs = HANDOVER_WAIT_MS, pollMs = 250 }: AskOptions,
): Promise<"left" | "stopped"> => {
    await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies Handover));
    try {
        const left = await pollUntil(async () => (await holderNow()) !== holder, { intervalMs: pollMs, timeoutMs: waitMs });
        if (left) {
            return "left";
        }
        await stop(holder);
        return "stopped";
    } finally {
        await rm(path, { force: true });
    }
};
