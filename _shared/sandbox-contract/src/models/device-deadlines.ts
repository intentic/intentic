import { z } from "zod";

// WHICH DEVICE TOOLS CARRY A DEADLINE OF THEIR OWN (2026-10-27). A post-mortem of 739k agent tool calls found 48 device
// calls cut at exactly 60.0 s with "The operation timed out.": the agent's MCP client gave up at its own default minute
// while `run_command`'s schema promised 120 s by default and 600 s at most, and the command ran on with nobody waiting.
// The machine (which enforces these) and the daemon (which sizes the bridge's wait on each call from them) read this one
// table, so a call's transport deadline follows the deadline the call itself asked for.

/** What passing a call's own deadline ends on the device. */
export type DeadlineEnds =
    // The command, together with everything it started (run_command, android_shell).
    | "command"
    // Only the wait: the program being watched (app_status, app_logs with waitFor or untilExit) runs on.
    | "wait";

// The arguments a deadline is read from. One of the wrong type reads as absent rather than failing the parse: such a
// call never runs, since the device checks its input against its own schema before anything else.
export const DeadlineArgumentsSchema = z.looseObject({
    timeoutMs: z.number().positive().optional().catch(undefined),
    waitFor: z.string().optional().catch(undefined),
    untilExit: z.boolean().optional().catch(undefined),
});
export type DeadlineArguments = z.infer<typeof DeadlineArgumentsSchema>;

export interface OwnDeadline {
    readonly defaultMs: number;
    readonly maxMs: number;
    readonly ends: DeadlineEnds;
    /** Whether a call with these arguments waits at all; absent means it always does. */
    readonly applies?: (args: DeadlineArguments) => boolean;
}

// A wait is asked for, never assumed: app_status and app_logs without one answer at once.
const appWait: OwnDeadline = {
    defaultMs: 60_000,
    maxMs: 10 * 60_000,
    ends: "wait",
    applies: (args) => args.waitFor !== undefined || args.untilExit === true,
};

/** The device tools whose `timeoutMs` argument bounds them, by tool name. */
export const DEVICE_OWN_DEADLINES = {
    // Long enough for an install or a test run, short of the hub's 15-minute ceiling.
    run_command: { defaultMs: 120_000, maxMs: 10 * 60_000, ends: "command" },
    android_shell: { defaultMs: 60_000, maxMs: 10 * 60_000, ends: "command" },
    app_status: appWait,
    app_logs: appWait,
} as const satisfies Readonly<Record<string, OwnDeadline>>;

const BY_TOOL = new Map<string, OwnDeadline>(Object.entries(DEVICE_OWN_DEADLINES));

/** The longest any device tool's own deadline can be asked to run. */
export const LONGEST_OWN_DEADLINE_MS = Math.max(...[...BY_TOOL.values()].map((own) => own.maxMs));

/** The deadline one call runs under on the device: its own `timeoutMs`, else the tool's default, never past the maximum. */
export const ownDeadlineOf = (tool: string, args: DeadlineArguments): { readonly ms: number; readonly ends: DeadlineEnds } | undefined => {
    const own = BY_TOOL.get(tool);
    if (own === undefined || own.applies?.(args) === false) {
        return undefined;
    }
    return { ms: Math.min(args.timeoutMs ?? own.defaultMs, own.maxMs), ends: own.ends };
};
