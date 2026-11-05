import { z } from "zod";

/* WHAT A RUNAWAY LEAVES ON THE RECORD, AND THE BOUNDS THAT STOP ONE (2026-11-05). One process an agent started grew to
   17.6 GB of RSS and 33 GB of swap: the container's swap was unbounded (the engine dropped `--memory-swap`), the WSL VM
   thrashed for 1 h 48 m, the daemon's event loop froze, netd killed it and then every daemon it restarted, and five turns
   came back interrupted with nothing on file saying why. This module is the one vocabulary every side of the fix shares:
   - the bounds the `workload` cgroup leaf is held to (the entrypoint and daemon-cgroup.ts write them, ic reports them);
   - the three JSON-lines files under /history/logs that netd (Rust, _sandbox/netd memguard.rs and vitals.rs) writes and
     the daemon reads, so a kill made while Node's event loop was frozen is still told to the conversation it hurt and
     named by the next boot. netd mirrors these shapes by hand: a field renamed here is renamed there.
   - the post-mortem the boot draws from them (system/boot/restarts) and the resume pass reads. */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/* THE WORKLOAD LEAF'S BOUNDS. Everything but netd and the daemon runs in /sys/fs/cgroup/workload. */

// The leaf's default swap (SANDBOX_SWAP unset) is not here: it is @intentic/sandbox-run's `defaultSandboxSwapGib`, which
// also sizes the engine's `--memory-swap`, so the run contract and this leaf take one number from one formula. It takes
// whole GiB and floors them, so a cap in bytes is passed as `capBytes / GIB`.

// What the workload leaf leaves the daemon below the sandbox's cap, so that a runaway meets the leaf's wall while the
// daemon still allocates without reclaiming: its heap ceiling (--max-old-space-size=3072) and half a GiB, or a quarter
// of a small cap, whichever is less.
const DAEMON_RESERVE_MAX_BYTES = 3.5 * GIB;

/** The workload leaf's memory.max for a sandbox cap of `capBytes`, rounded down to a MiB. */
export const workloadMemoryMax = (capBytes: number): number => {
    const reserve = Math.min(DAEMON_RESERVE_MAX_BYTES, capBytes / 4);
    return Math.floor((capBytes - reserve) / MIB) * MIB;
};

// The env var ic sets on the container (`<n>g`, whole GiB of swap for the workload leaf, the swap alone, not memory plus
// swap), and the file ic writes into a running container when the owner reshapes it live (`{"swapGib": n}`): the file wins
// over the env var, and a recreate starts without it because it lives on the container's own filesystem.
export const SWAP_ENV = "SANDBOX_SWAP";
export const WORKLOAD_BOUNDS_OVERRIDE = "/run/intentic/workload-bounds.json";
export const WorkloadBoundsOverrideSchema = z.object({ swapGib: z.number().int().min(1) });

/* THE RECORDS. */

export const MEMORY_KILLS_FILE = "memory-kills.jsonl";
export const NETD_KILLS_FILE = "netd-kills.jsonl";
export const PRESSURE_FILE = "pressure.jsonl";

const PsiSchema = z.object({
    someAvg10: z.number().describe("Share of the last 10 s some task stalled on memory, in percent."),
    fullAvg10: z.number().describe("Share of the last 10 s every task stalled on memory, in percent."),
});
export type Psi = z.infer<typeof PsiSchema>;

// One process killed for memory. `owner` is the INTENTIC_TURN_OWNER stamp read from its environment (a conversation id,
// or `daemon` / `one-shot`); `jobId` the background job whose process group it was in, when the daemon knew one.
export const MemoryKillSchema = z.object({
    at: z.number().describe("When it was killed, epoch milliseconds."),
    killer: z
        .enum(["netd-guard", "cgroup-oom", "kernel-oom"])
        .describe("netd's memory guard; the kernel inside the sandbox's own cgroup; the kernel for the whole machine."),
    pid: z.number().int(),
    comm: z.string(),
    argv: z.string().optional().describe("Its command line, cut to 300 characters."),
    rssBytes: z.number().optional(),
    swapBytes: z.number().optional(),
    oomScore: z.number().optional(),
    pgid: z.number().int().optional(),
    owner: z.string().optional(),
    jobId: z.string().optional(),
    cgroup: z.string().optional(),
    psi: PsiSchema.optional(),
    reason: z.string().optional().describe("Why, in words: the pressure or the bound that made the call."),
});
export type MemoryKill = z.infer<typeof MemoryKillSchema>;

// What netd did to the daemon: killed it (`stuck`: a ping unanswered; `no-hello`: never came up), or held a restart while
// the machine was short of memory (`restart-held`), and with what memory pressure in the sandbox at the time.
export const NetdKillSchema = z.object({
    at: z.number(),
    kind: z.enum(["stuck", "no-hello", "restart-held"]),
    pid: z.number().int().optional(),
    silentMs: z.number().optional().describe("How long the daemon had not answered (stuck) or not said hello (no-hello)."),
    heldMs: z.number().optional().describe("restart-held: how long the restart waited."),
    psi: PsiSchema.optional(),
});
export type NetdKill = z.infer<typeof NetdKillSchema>;

const PressureTopSchema = z.object({
    pid: z.number().int(),
    comm: z.string(),
    rssBytes: z.number(),
    swapBytes: z.number(),
    oomScore: z.number().optional(),
    owner: z.string().optional(),
});

// netd's sample while memory is short, written and flushed at once, so a freeze that silences the daemon's own sampler
// still leaves a trail.
export const PressureSampleSchema = z.object({
    at: z.number(),
    memoryCurrent: z.number().optional(),
    memoryMax: z.number().optional(),
    swapCurrent: z.number().optional(),
    swapMax: z.number().optional(),
    psi: PsiSchema,
    top: z.array(PressureTopSchema),
});
export type PressureSample = z.infer<typeof PressureSampleSchema>;

/** Every line of a JSON-lines file that parses as `schema`; a torn or foreign line is skipped, never fatal. */
export const parseLines = <T>(text: string, schema: z.ZodType<T>): T[] =>
    text.split("\n").flatMap((line) => {
        if (line.trim() === "") {
            return [];
        }
        try {
            const parsed = schema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
        } catch {
            // allow(silent-catch): a line torn by a kill mid-write is the expected damage of the moment it records
            return [];
        }
    });

/* THE POST-MORTEM: what the boot after an unclean stop concludes, and what the resume pass decides on. */

export const PostMortemSchema = z.object({
    cause: z
        .enum(["memory", "netd-stuck", "oom-victim", "unknown"])
        .describe(
            "memory: something was killed for memory around the stop; netd-stuck: netd killed a daemon whose loop stopped, with no memory kill on file; oom-victim: the kernel killed the daemon itself; unknown: none of these on file.",
        ),
    killed: z.array(MemoryKillSchema).describe("Every process killed for memory between the previous boot and this one."),
    netd: z.array(NetdKillSchema).describe("What netd did to the daemon in the same span."),
    // Conversations whose own process was killed: their cut turns are held with this record rather than resumed.
    culprits: z.array(z.string()),
    summary: z.string().describe("The named cause in one sentence, for the restart record and the held turn's notice."),
});
export type PostMortem = z.infer<typeof PostMortemSchema>;
