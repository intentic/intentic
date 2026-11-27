import { z } from "zod";

/* WHAT A COMPUTER'S OWN OS DOES TO WORK LEFT RUNNING ON IT (2026-11-22). Two sandboxes on rog had sessions booked for the
   night. rog's power plan put it to sleep five hours after its owner's last keypress, at 05:37, and nothing on it ran
   again until the lid was opened at 10:01: a send booked for 07:10 went out three hours late, and nobody had been told
   this would happen. The machine agent now reads the settings that decide this (machine `power/`) and reports each one
   that would stop a sandbox's scheduled work as a finding, in its facts (`DeviceFacts.power`). The daemon raises a
   `host-power` card when something is booked that one of them would stop (needs.ts), and the owner's yes runs the
   agent's `power-stay-on` op (DeviceAgentOpSchema), which changes those settings on mains power and leaves battery as it
   is: a laptop in a bag must still sleep.

   Finding ids are strings, not an enum, so a finding a newer agent adds is one more line rather than facts that fail to
   parse; `text` is the agent's own sentence for it, which a reader shows when it has no words of its own for the id. */

// The ids this build knows. Each is one setting or one OS behaviour, on one power source where that matters.
export const POWER_FINDING = {
    // Windows: "Sleep after" is set, on mains power, in at least one power plan.
    sleepIdle: "sleep-idle",
    // Windows: "Hibernate after" is set, on mains power.
    hibernateIdle: "hibernate-idle",
    // Windows: closing the lid on mains power sleeps, hibernates or shuts the computer down.
    lidClose: "lid-close",
    // Windows Modern Standby: the network is cut while the screen is off, so a provider call from a turn fails.
    standbyNetwork: "standby-network",
    // Windows: on battery it still sleeps (after `afterSeconds`, or when the lid closes). Reported, never changed.
    batterySleep: "battery-sleep",
    // Windows Update may restart the computer outside its active hours (`window`). Never changed by `power-stay-on`; the
    // agent's `update-pause` and `before-sign-in` ops answer it (`offers`, POWER_REMEDY), and `comesBack` says whether the
    // computer's sandboxes start again by themselves after it or wait for somebody to sign in.
    updateRestart: "update-restart",
    // Linux or macOS: the OS may suspend the computer; the fix needs root, so `command` says what to run.
    osSleep: "os-sleep",
} as const;

/* WHAT ANSWERS A NIGHT RESTART (2026-11-27). The card about Windows Update used to say what would happen and offer nothing
   but "Not now": the restart window is Windows', and after one nothing ran until somebody signed in. Two answers, each an
   agent op the owner's yes runs (DeviceAgentOpSchema): Windows Update paused until after the booked work (`update-pause`,
   for the night in question), and Windows' boot task (`before-sign-in`), which starts the agent with no session, and the
   agent then starts intentic's engine and the sandboxes on it, so a restart costs minutes rather than the night. The
   second needs intentic's engine: Docker Desktop is a program with a window and starts only at a sign-in, so the agent
   offers it only where the sandboxes run on intentic's engine. */
export const POWER_REMEDY = {
    pauseUpdates: "update-pause",
    beforeSignIn: "before-sign-in",
} as const;

// The longest Windows lets updates be paused for: five weeks, as its own Settings page offers.
export const UPDATE_PAUSE_MAX_MS = 35 * 24 * 3_600_000;
// Where the agent did not say when restarts may happen, how long past the booked work a pause holds.
const PAUSE_PAST_DUE_MS = 2 * 3_600_000;

export const HostPowerFindingSchema = z.object({
    id: z.string().min(1).describe("Which setting or behaviour (POWER_FINDING), as a string so a newer agent's id still parses."),
    power: z.enum(["ac", "dc"]).optional().describe("The power source it applies to: ac is mains, dc is battery. Absent where that does not matter."),
    afterSeconds: z.number().int().positive().optional().describe("For a timeout: how long without input before it acts, the shortest across power plans."),
    action: z.string().optional().describe("For the lid: what closing it does now, `sleep`, `hibernate` or `shut-down`."),
    window: z
        .object({
            fromHour: z.number().int().min(0).max(23),
            toHour: z.number().int().min(0).max(23),
        })
        .optional()
        .describe("For an update restart: the local hours it may happen in, from `fromHour` up to `toHour` (wrapping past midnight)."),
    plans: z.array(z.string()).optional().describe("Windows: the power plans that hold the value, by name. A vendor may switch between them by itself."),
    fixable: z.boolean().describe("Whether the agent's `power-stay-on` op changes it."),
    command: z.string().optional().describe("Where the agent cannot change it: the command a person runs on that computer."),
    offers: z
        .array(z.string())
        .optional()
        .describe("The agent ops other than `power-stay-on` that answer it (POWER_REMEDY), as strings so a newer agent's still parses."),
    pausedUntil: z.number().optional().describe("For an update restart: Windows Update is paused until then (epoch ms), so it restarts nothing before it."),
    restartPending: z
        .boolean()
        .optional()
        .describe("For an update restart: an update is already installed and waiting for a restart, which a pause may not hold off."),
    comesBack: z
        .enum(["sign-in", "boot"])
        .optional()
        .catch(undefined)
        .describe("For an update restart: what starts this computer's sandboxes again after it, somebody signing in or the computer starting."),
    text: z.string().min(1).describe("What it does now, in the agent's words (English), for a reader with none of its own for this id."),
});
export type HostPowerFinding = z.infer<typeof HostPowerFindingSchema>;

export const HostPowerSchema = z.object({
    at: z.number().describe("When the settings were read, in epoch ms."),
    utcOffsetMinutes: z
        .number()
        .int()
        .describe("The computer's local time minus UTC, in minutes, when read: what places a finding's local `window` on another clock."),
    battery: z.boolean().optional().describe("Whether the computer has a battery at all."),
    findings: z.array(HostPowerFindingSchema).describe("Everything its OS would do to stop or delay work left running; empty when nothing would."),
});
export type HostPower = z.infer<typeof HostPowerSchema>;

/** The findings the agent's `power-stay-on` op would change. Pure. */
export const fixablePowerFindings = (power: Pick<HostPower, "findings"> | undefined): HostPowerFinding[] =>
    (power?.findings ?? []).filter((finding) => finding.fixable);

/**
 * Whether `at` (epoch ms) falls inside a finding's local-hours `window` on a computer `utcOffsetMinutes` from UTC: the
 * window runs from `fromHour` up to `toHour`, past midnight when `toHour` is the smaller. Pure.
 */
export const insideLocalWindow = (at: number, window: NonNullable<HostPowerFinding["window"]>, utcOffsetMinutes: number): boolean => {
    const local = new Date(at + utcOffsetMinutes * 60_000);
    const hour = local.getUTCHours();
    if (window.fromHour === window.toHour) {
        return true;
    }
    return window.fromHour < window.toHour ? hour >= window.fromHour && hour < window.toHour : hour >= window.fromHour || hour < window.toHour;
};

/**
 * When `update-pause` should hold Windows Update until, for work due at `dueAt`: the end of the first restart window
 * that ends at or after it, so the night the work runs in is left alone, or two hours past it where the finding names no
 * window. Undefined where that is further off than Windows lets updates be paused from `now`. Pure.
 */
export const pauseUntilFor = (finding: Pick<HostPowerFinding, "window">, utcOffsetMinutes: number, now: number, dueAt: number): number | undefined => {
    const window = finding.window;
    let until = dueAt + PAUSE_PAST_DUE_MS;
    if (window !== undefined && window.fromHour !== window.toHour) {
        // The next local `toHour` o'clock at or after dueAt, on the computer's own clock.
        const local = new Date(dueAt + utcOffsetMinutes * 60_000);
        const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), window.toHour) - utcOffsetMinutes * 60_000;
        until = end >= dueAt ? end : end + 24 * 3_600_000;
    }
    return until - now > UPDATE_PAUSE_MAX_MS ? undefined : until;
};

const HOUR_MS = 3_600_000;
// A local-hours window repeats daily, so a day of hour starts visits every hour it could hold.
const HOURS_A_DAY = 24;

/**
 * Whether any moment from `from` to `to` (epoch ms) falls inside a local-hours window on a computer `utcOffsetMinutes`
 * from UTC. The window is whole local hours, so it is enough to look at `from` and at each local hour's start up to `to`,
 * for at most a day: past that the same hours only come round again. Pure.
 */
export const windowMeets = (window: NonNullable<HostPowerFinding["window"]>, utcOffsetMinutes: number, from: number, to: number): boolean => {
    if (insideLocalWindow(from, window, utcOffsetMinutes)) {
        return true;
    }
    // The next local hour's start: an offset like +05:30 puts the computer's hours off UTC's.
    const local = from + utcOffsetMinutes * 60_000;
    let at = from - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS) + HOUR_MS;
    for (let step = 0; step < HOURS_A_DAY && at <= to; step += 1, at += HOUR_MS) {
        if (insideLocalWindow(at, window, utcOffsetMinutes)) {
            return true;
        }
    }
    return false;
};

/**
 * Whether an `update-restart` finding would stop work due at `dueAt`, read at `now`: a restart inside its hours between
 * now (or the end of Windows Update's pause, if later) and the work, after which the sandboxes wait for a sign-in. Never
 * where they start again with the computer (`comesBack: boot`), and at any hour where the agent did not say which. Pure.
 */
export const restartBlocks = (
    finding: Pick<HostPowerFinding, "window" | "pausedUntil" | "comesBack">,
    utcOffsetMinutes: number,
    now: number,
    dueAt: number,
): boolean => {
    if (finding.comesBack === "boot") {
        return false;
    }
    const from = Math.max(now, finding.pausedUntil ?? now);
    if (from >= dueAt && finding.pausedUntil !== undefined) {
        return false;
    }
    return finding.window === undefined || windowMeets(finding.window, utcOffsetMinutes, from, dueAt);
};
