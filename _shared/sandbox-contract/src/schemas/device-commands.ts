import { z } from "zod";

// Closed names let the daemon build argv without granting arbitrary shell access; dev/sync commands never accept caller paths or tokens.
// Use existing run_command for older-agent compatibility; poll dev-rebuild-log because rebuilds are detached.
// sync-unpair terminates sessions/revokes enrollment; sync-clean removes ignored build residue only.
// mirror-ignore/unignore persists per-device port choices without muting all mirrored ports.
export const DeviceCommandSchema = z.enum([
    "mirror-off",
    "mirror-on",
    "mirror-ignore",
    "mirror-unignore",
    "sync-pause",
    "sync-resume",
    "sync-unpair",
    "sync-clean",
    "dev-restart",
    "dev-rebuild",
    "dev-rebuild-log",
    // The rebuild's three levers, each a file beside its log on the machine (dev-rebuild-log.ts): hold the restart at
    // the swap gate, let it through, or stop the build before the gate is passed.
    "dev-rebuild-hold",
    "dev-rebuild-release",
    "dev-rebuild-cancel",
    "sync-install",
]);
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
// The reversible sync switches: the subset a device's own row drives with a pair of buttons, as opposed to the two
// commands a card elsewhere issues once. Its own type so those button tables stay total without carrying entries for
// commands they can never send.
export const DeviceSyncSwitchSchema = DeviceCommandSchema.exclude([
    "dev-restart",
    "dev-rebuild",
    "dev-rebuild-log",
    "dev-rebuild-hold",
    "dev-rebuild-release",
    "dev-rebuild-cancel",
    "sync-install",
    "sync-clean",
]);
export type DeviceSyncSwitch = z.infer<typeof DeviceSyncSwitchSchema>;

// Where a detached rebuild reports itself, and the reader of that report (dev-rebuild-log.ts).
export {
    DEV_REBUILD_CANCEL_MARK,
    DEV_REBUILD_EXIT_MARK,
    DEV_REBUILD_HOLD_MARK,
    DEV_REBUILD_QUIET_MARK,
    DEV_REBUILD_SWAP_MARK,
    DEV_REBUILD_TASKS_MARK,
    DEV_REBUILD_WAITING_MARK,
    type DevRebuildLog,
    type DevRebuildTasks,
    devRebuildHoldPath,
    devRebuildLogPath,
    devRebuildPidPath,
    readDevRebuildLog,
} from "./dev-rebuild-log.js";

// Machine's sandbox id (absent = every paired sandbox); must start alphanumeric, else it parses as a CLI flag.
export const DeviceSandboxIdSchema = z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
// A folder on the DEVICE for `sync-install` to keep in step. The only caller-supplied string that reaches a command
// line, so its shape is the guard: `~`, an absolute POSIX path or a drive letter, and none of the characters that would
// end the argument it sits in. `~` is expanded by the daemon, which is why `$` is not allowed to arrive here. The line
// may be PowerShell, which reads the typographic quotes “ ” „ as double quotes and ‘ ’ ‚ ‛ as single quotes beside the
// ASCII ones, so those are refused too: the daemon quotes the folder, and this keeps a second guard where one quoter
// misses a character.
export const DeviceLocalDirSchema = z
    .string()
    .min(1)
    .max(4096)
    // The curly quotes as escapes: bun's transpiler rewrites a literal one in a regex to its escape and tsc keeps it,
    // so spelled literally the pattern reads differently from source and from dist, and contract.lock.json can match
    // only one of them.
    .regex(/^(?:~|\/|[A-Za-z]:[\\/])[^"'`$;|&\n\r\u201C\u201D\u201E\u2018\u2019\u201A\u201B]*$/);
// A TCP port number, the one value a caller supplies that reaches a command line as a number rather than a string.
export const PortNumberSchema = z.number().int().min(1).max(65535);
export const DeviceCommandInputSchema = z.object({
    id: z.string().min(1),
    command: DeviceCommandSchema,
    sandboxId: DeviceSandboxIdSchema.optional(),
    // `sync-install` only: which half to enroll (a member's "sync" still comes back mirror, decided daemon-side) and,
    // for file sync, the folder on that device. The pairing token is minted by the daemon; no caller ever carries one.
    mode: z.enum(["sync", "mirror"]).optional(),
    localDir: DeviceLocalDirSchema.optional(),
    // The two per-port mirror switches only. A number rather than a string, so nothing a caller sends can widen the
    // command line it lands in.
    port: PortNumberSchema.optional(),
});
export type DeviceCommandInput = z.infer<typeof DeviceCommandInputSchema>;
// `ok` is the command's own exit status, not this route's: a refusal or non-zero exit is a real answer, not a thrown
// error. Only an unreachable machine throws. `output` is the command's own printed text.
export const DeviceCommandResultSchema = z.object({
    ok: z.boolean(),
    message: z.string(),
    output: z.string().optional(),
    // WHICH KIND OF `ok: false` THIS IS, because a caller that repeats itself needs to tell them apart: the device
    // turning the command away (a switch of its own is off, the path is out of its reach) will turn it away again,
    // whereas a command it accepted and then killed at its deadline says nothing except that this attempt was too slow.
    refused: z.boolean(),
});
export type DeviceCommandResult = z.infer<typeof DeviceCommandResultSchema>;

