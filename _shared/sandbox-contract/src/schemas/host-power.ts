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
    // Windows Update may restart the computer outside its active hours (`window`), and after a restart nothing runs
    // until somebody signs in. Reported, never changed.
    updateRestart: "update-restart",
    // Linux or macOS: the OS may suspend the computer; the fix needs root, so `command` says what to run.
    osSleep: "os-sleep",
} as const;

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
