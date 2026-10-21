import { z } from "zod";

// Closed set of command names; the daemon builds argv from the name alone (hosts/device-commands.ts). Never a free-text
// command: the same socket carries `run_command`, which would grant a shell on the user's machine.
// `sync-unpair` runs the machine's own `sync uninstall --sandbox` (terminates both Mutagen sessions, drops the pairing,
// self-revokes enrollment); revoking from the sandbox side is a different route.
// `dev-restart`, `dev-rebuild` and `sync-install` are the three whose argv the daemon fills from what only it knows — the
// dev checkout on that machine, a freshly minted pairing token — which is also why none takes a path or a token from the
// caller. The two dev commands are also why a machine-side op is the wrong shape for them: this door carries a COMMAND
// STRING to a tool every released agent already has, so a sandbox can drive a machine whose agent predates the feature.
// `dev-rebuild-log` is the read side of `dev-rebuild`: the build is detached out there, so its log is the only place its
// progress exists, and polling this is what turns a fired-and-forgotten command into something with a progress bar.
// `sync-clean` removes the build output left in directories the sandbox has deleted, which is what stops those
// deletions from ever landing. It deletes only content the session already ignores, so it is the one command here whose
// worst outcome is a rebuild — which is why it is a button and not a turn.
// `mirror-ignore`/`mirror-unignore` are `mirror-off`'s per-port form, and the reason they exist: a port number that is
// permanently taken on one machine's localhost has no answer in an all-or-nothing switch, so the choice lives where the
// conflict does — one port, one device, durable — instead of muting every port the pairing serves.
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
    "sync-install",
]);
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;
// The reversible sync switches: the subset a device's own row drives with a pair of buttons, as opposed to the two
// commands a card elsewhere issues once. Its own type so those button tables stay total without carrying entries for
// commands they can never send.
export const DeviceSyncSwitchSchema = DeviceCommandSchema.exclude(["dev-restart", "dev-rebuild", "dev-rebuild-log", "sync-install", "sync-clean"]);
export type DeviceSyncSwitch = z.infer<typeof DeviceSyncSwitchSchema>;

// Where a detached rebuild reports itself, and the reader of that report (dev-rebuild-log.ts).
export { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK, type DevRebuildLog, devRebuildLogPath, readDevRebuildLog } from "./dev-rebuild-log.js";

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
    // The curly quotes as escapes: bun's transpiler rewrites a literal one in a regex to its escape and tsgo keeps it,
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

