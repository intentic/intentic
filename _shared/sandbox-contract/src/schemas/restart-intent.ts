import { z } from "zod";

// WHY THE SANDBOX IS ABOUT TO GO DOWN, as the file whoever restarts it leaves on its volume (/history/logs/restart-intent.json).
//
// Four writers, three languages: the daemon itself (an idle-stop, an update when quiet, an owner's restart from the Devices
// card), `ic` (Rust: the verb it is about to run), the machine agent's keeper (TypeScript: the restart a repair makes), and the
// desktop app. The daemon reads it at its next boot and files the previous run's end against it (boot/restarts/restart-record.ts).
// One schema, so a writer cannot name an initiator, an action or a side the reader's words do not have: `ic`'s Rust and the
// keeper's TypeScript are held to it by the daemon's golden/host-files.json (host-files.test.ts writes the enumerations and an
// example from here; ic's host_files.rs and the keeper's test read them back).

// Who acted. `owner` is a person at the editor, `daemon` the sandbox itself, `ic` a person running ic or the desktop app's ic,
// `keeper` the machine agent's unattended round, `desktop` the desktop app's own restart.
export const RESTART_INITIATORS = ["owner", "daemon", "ic", "keeper", "desktop"] as const;
// What is about to happen to the container: `swap` is onto another version that is not the channel's newest (a rollback, or
// going back from a failed update).
export const RESTART_ACTIONS = ["restart", "stop", "update", "swap", "reshape", "recreate", "rebuild"] as const;
// The side of a computer the initiator runs on.
export const RESTART_SIDES = ["wsl", "windows", "linux", "mac"] as const;

// What a writer puts in the file.
export const RestartIntentSchema = z.object({
    // ISO time it was written, right before the stop it announces.
    at: z.string().refine((at) => Number.isFinite(Date.parse(at)), "an ISO moment"),
    by: z.enum(RESTART_INITIATORS),
    // The machine the initiator runs on, and which side of it.
    host: z.string().optional(),
    side: z.enum(RESTART_SIDES).optional(),
    action: z.enum(RESTART_ACTIONS),
    reason: z.string(),
    // For a keeper's repair: the health checks that failed and made it act.
    checks: z.array(z.string()).optional(),
});
export type RestartIntent = z.infer<typeof RestartIntentSchema>;
export type RestartInitiator = RestartIntent["by"];
export type RestartAction = RestartIntent["action"];
export type RestartSide = NonNullable<RestartIntent["side"]>;

// What the daemon makes of a file it reads. Lenient where a writer newer than this daemon may be ahead of it: an initiator, an
// action or a side it does not know still says more than no intent at all, so those three read as the words they were. `at` is
// held to its meaning, since freshness is decided on it.
export const ReadRestartIntentSchema = RestartIntentSchema.extend({
    by: z.string().min(1),
    side: z.string().optional(),
    action: z.string().min(1),
});
export type ReadRestartIntent = z.infer<typeof ReadRestartIntentSchema>;
