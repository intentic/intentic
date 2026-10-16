import { z } from "zod";

// INTENTIC OS (2026-10-13): the immutable Linux that boots straight into Intentic (_os/README.md). Everything that changes
// the OS goes through `ic os`, and everything that calls it reads ic's JSON rather than bootc's. This is that JSON as the
// TypeScript side reads it, and the argv every caller spells it with: the machine agent's os_* tools run it, and a page
// that cannot reach the machine can print it for a person to type. golden/intentic-os.json holds an example of each
// answer, for ic's Rust to produce field for field.

/** What `ic os status` says the OS is called, and what the machine agent reports in its facts. */
export const INTENTIC_OS_NAME = "intentic-os";

/** Written by the image build; a machine without it is not Intentic OS, and `ic os` refuses there. */
export const INTENTIC_OS_RELEASE_PATH = "/usr/lib/intentic-os/release.json";

/** The exit code `ic os` refuses with on a machine that is not Intentic OS. */
export const IC_OS_NOT_INTENTIC_OS_EXIT = 3;

// `/usr/lib/intentic-os/release.json`, as the image build writes it. `name` is the human one ("Intentic OS").
// Read loosely: a field a newer image adds is ignored, and only the four the facts carry are required.
export const IntenticOsReleaseSchema = z.object({
    name: z.string(),
    edition: z.string().min(1),
    version: z.string().min(1),
    channel: z.string().min(1),
    repository: z.string().optional(),
});
export type IntenticOsRelease = z.infer<typeof IntenticOsReleaseSchema>;

// What a device on Intentic OS reports in its facts (DeviceFacts.intenticOs), read off release.json at connect. Strings
// on the wire, like every fact, so an edition or channel a newer image names never fails an older daemon's read.
export const IntenticOsFactsSchema = z.object({
    // Always INTENTIC_OS_NAME from a current agent; compared, never trusted to be a literal.
    name: z.string(),
    edition: z.string(),
    version: z.string(),
    channel: z.string(),
});
export type IntenticOsFacts = z.infer<typeof IntenticOsFactsSchema>;

export const intenticOsFactsFrom = (release: IntenticOsRelease): IntenticOsFacts => ({
    name: INTENTIC_OS_NAME,
    edition: release.edition,
    version: release.version,
    channel: release.channel,
});

/** Whether a device's facts say it runs Intentic OS. */
export const isIntenticOs = (facts: { readonly intenticOs?: { readonly name: string } | undefined } | undefined): boolean =>
    facts?.intenticOs?.name === INTENTIC_OS_NAME;

// A channel is the image tag. `ic os channel` takes only these two; `status` reads the booted image's tag and says
// whatever it is, so the status field stays a string.
export const IntenticOsChannelSchema = z.enum(["stable", "beta"]);
export type IntenticOsChannel = z.infer<typeof IntenticOsChannelSchema>;

// One bootc deployment (`status.booted|staged|rollback`), each field `null` where bootc does not say.
export const IntenticOsDeploymentSchema = z.object({
    image: z.string().nullable(),
    version: z.string().nullable(),
    digest: z.string().nullable(),
    // ISO 8601, as bootc gives it.
    timestamp: z.string().nullable(),
});
export type IntenticOsDeployment = z.infer<typeof IntenticOsDeploymentSchema>;

// The boot's health as `ic os health` last wrote it (`/run/intentic-os/health.json`): `unknown` before it ran, and
// `failed` names each failed check.
export const IntenticOsHealthVerdictSchema = z.enum(["green", "red", "unknown"]);
export const IntenticOsHealthSchema = z.object({ verdict: IntenticOsHealthVerdictSchema, failed: z.array(z.string()) });
export type IntenticOsHealth = z.infer<typeof IntenticOsHealthSchema>;

// How sandbox containers run (`/etc/intentic/os.json`): `container` is runc, `vm` a Kata microVM for every sandbox, and
// `auto` a microVM only for a sandbox started privileged.
export const IntenticOsIsolationSchema = z.enum(["auto", "vm", "container"]);
export type IntenticOsIsolation = z.infer<typeof IntenticOsIsolationSchema>;

// `ic os status --json`: one line. A key a newer ic adds is dropped, not refused.
export const IntenticOsStatusSchema = z.object({
    os: z.literal(INTENTIC_OS_NAME),
    edition: z.string(),
    version: z.string(),
    channel: z.string(),
    image: z.string(),
    // Nullable for a bootc that would not answer; `staged` and `rollback` are null when there is none.
    booted: IntenticOsDeploymentSchema.nullable(),
    staged: IntenticOsDeploymentSchema.nullable(),
    rollback: IntenticOsDeploymentSchema.nullable(),
    rollbackQueued: z.boolean(),
    // `staged != null || rollbackQueued`: the next boot changes what runs.
    rebootRequired: z.boolean(),
    health: IntenticOsHealthSchema,
    isolation: IntenticOsIsolationSchema,
    // Whether dockerd has the `kata` runtime.
    vmRuntime: z.boolean(),
});
export type IntenticOsStatus = z.infer<typeof IntenticOsStatusSchema>;

// `ic os update --check --json`: whether the registry has a newer image, and which. `version` and `digest` are null
// when there is none.
export const IntenticOsUpdateCheckSchema = z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    digest: z.string().nullable(),
});
export type IntenticOsUpdateCheck = z.infer<typeof IntenticOsUpdateCheckSchema>;

// What an update does: `check` asks and changes nothing, `stage` downloads and stages for the next boot and restarts
// nothing, `apply` stages and then reboots the machine into it.
export const IntenticOsUpdateOpSchema = z.enum(["check", "stage", "apply"]);
export type IntenticOsUpdateOp = z.infer<typeof IntenticOsUpdateOpSchema>;

// THE ARGV, the one place any caller spells `ic os`. The verbs that reboot (`update --apply`, `rollback --apply`,
// `reboot`) first leave every running sandbox the daemon's resume ask and record what runs, as every restart ic makes
// does: none of that is the caller's to do.
export const icOsStatusArgs = (): string[] => ["os", "status", "--json"];

export const icOsUpdateArgs = (op: IntenticOsUpdateOp): string[] => {
    if (op === "check") {
        return ["os", "update", "--check", "--json"];
    }
    return op === "apply" ? ["os", "update", "--apply"] : ["os", "update"];
};

export const icOsRollbackArgs = (apply: boolean): string[] => (apply ? ["os", "rollback", "--apply"] : ["os", "rollback"]);

export const icOsRebootArgs = (): string[] => ["os", "reboot"];

// Checked here too, not only by a caller's schema: a channel is a positional, and one beginning with a hyphen would
// reach ic as a flag.
export const icOsChannelArgs = (channel: IntenticOsChannel): string[] => ["os", "channel", IntenticOsChannelSchema.parse(channel)];

// THE MACHINE'S OWN SETTINGS (2026-10-16): the network, the sound, the screen, the keyboard and the drives a person plugs
// in, each a verb of `ic os` (_os/README.md, "Settings"). The desktop app's This computer cards, its status bar and the
// machine agent's tools all read these shapes, so a person and the agent in the machine's own sandbox change the same
// things the same way ("connect to the guest Wi-Fi"). ic reads NetworkManager, WirePlumber, sway and udisks for them:
// nothing that calls ic speaks to those.

/** Exit code of the screen verbs (display, keyboard) on an edition with no screen (the server edition). */
export const IC_OS_NO_SCREEN_EXIT = 4;

/** Exit code of `ic os network wifi connect` when the network needs a password it was not given, or refused the one it
 *  was: ask the person for it and try again with `--password-stdin`. */
export const IC_OS_WIFI_PASSWORD_EXIT = 5;

/** Exit code of `ic os drives import` when what is on the drive would not fit in the sandbox: nothing was copied. */
export const IC_OS_DRIVE_NO_ROOM_EXIT = 6;

// `ic os network status --json`: how this machine is online right now. `name` is the Wi-Fi network's name or the wired
// connection's, `signal` the Wi-Fi strength 0-100 (null on a wire and offline). The status bar reads exactly this.
export const IntenticOsNetworkKindSchema = z.enum(["wifi", "ethernet", "none"]);
export type IntenticOsNetworkKind = z.infer<typeof IntenticOsNetworkKindSchema>;

const percent = z.number().int().min(0).max(100);

export const IntenticOsNetworkStatusSchema = z.object({
    connected: z.boolean(),
    kind: IntenticOsNetworkKindSchema,
    name: z.string().nullable(),
    signal: percent.nullable(),
});
export type IntenticOsNetworkStatus = z.infer<typeof IntenticOsNetworkStatusSchema>;

// One Wi-Fi network in reach, once however many access points broadcast it: the strongest signal, `secured` when it
// asks for a password, `known` when this machine has joined it before (it rejoins without asking), `active` when it is
// the one in use.
export const IntenticOsWifiNetworkSchema = z.object({
    ssid: z.string(),
    signal: percent,
    secured: z.boolean(),
    known: z.boolean(),
    active: z.boolean(),
});
export type IntenticOsWifiNetwork = z.infer<typeof IntenticOsWifiNetworkSchema>;

// `ic os network wifi list --json`: `adapter` false on a machine with no Wi-Fi, `enabled` false while Wi-Fi is turned
// off (then `networks` is empty), the networks strongest first.
export const IntenticOsWifiListSchema = z.object({
    adapter: z.boolean(),
    enabled: z.boolean(),
    networks: z.array(IntenticOsWifiNetworkSchema),
});
export type IntenticOsWifiList = z.infer<typeof IntenticOsWifiListSchema>;

// `ic os sound status --json`: the volume of what plays now, 0-100, whether it is muted, and the speaker or headphones it
// plays on (null when this machine has none). The status bar reads exactly this.
export const IntenticOsSoundStatusSchema = z.object({
    volume: percent,
    muted: z.boolean(),
    output: z.string().nullable(),
});
export type IntenticOsSoundStatus = z.infer<typeof IntenticOsSoundStatusSchema>;

// `ic os sound outputs --json`: every speaker, headphone and screen that plays sound, `default` on the one in use.
// `id` is what `ic os sound output <id>` takes; it can change when a device is plugged in again.
export const IntenticOsSoundOutputSchema = z.object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    default: z.boolean(),
});
export type IntenticOsSoundOutput = z.infer<typeof IntenticOsSoundOutputSchema>;
export const IntenticOsSoundOutputsSchema = z.object({ outputs: z.array(IntenticOsSoundOutputSchema) });
export type IntenticOsSoundOutputs = z.infer<typeof IntenticOsSoundOutputsSchema>;

// A screen's mode: pixels across and down, and how many times a second it redraws (Hz, to three decimals).
export const IntenticOsDisplayModeSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    refresh: z.number().nonnegative(),
});
export type IntenticOsDisplayMode = z.infer<typeof IntenticOsDisplayModeSchema>;

// One screen as `ic os display list --json` says it: `name` is the connector (`HDMI-A-1`, `eDP-1`) every other verb
// names it by, `make` and `model` what the screen says it is (null where it does not), `current` the mode it shows now
// (null while it is off), `modes` every mode it offers, `scale` how much bigger everything is drawn (null while off).
export const IntenticOsDisplaySchema = z.object({
    name: z.string(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    enabled: z.boolean(),
    current: IntenticOsDisplayModeSchema.nullable(),
    modes: z.array(IntenticOsDisplayModeSchema),
    scale: z.number().positive().nullable(),
});
export type IntenticOsDisplay = z.infer<typeof IntenticOsDisplaySchema>;
export const IntenticOsDisplayListSchema = z.object({ outputs: z.array(IntenticOsDisplaySchema) });
export type IntenticOsDisplayList = z.infer<typeof IntenticOsDisplayListSchema>;

// `ic os keyboard status --json`: the layout in use as xkb names it (`us`, `de`), its variant (`nodeadkeys`, null for
// the layout's own), and its name for a person ("German (no dead keys)"), null when xkb has none for it.
export const IntenticOsKeyboardStatusSchema = z.object({
    layout: z.string(),
    variant: z.string().nullable(),
    name: z.string().nullable(),
});
export type IntenticOsKeyboardStatus = z.infer<typeof IntenticOsKeyboardStatusSchema>;

export const IntenticOsKeyboardVariantSchema = z.object({ variant: z.string(), name: z.string() });
export const IntenticOsKeyboardLayoutSchema = z.object({
    layout: z.string(),
    name: z.string(),
    variants: z.array(IntenticOsKeyboardVariantSchema),
});
export type IntenticOsKeyboardLayout = z.infer<typeof IntenticOsKeyboardLayoutSchema>;
// `ic os keyboard layouts --json`: every layout xkb knows, in its own order, each with its variants.
export const IntenticOsKeyboardLayoutsSchema = z.object({ layouts: z.array(IntenticOsKeyboardLayoutSchema) });
export type IntenticOsKeyboardLayouts = z.infer<typeof IntenticOsKeyboardLayoutsSchema>;

// What kind of removable drive: a USB stick or disk, or a memory card in a card reader.
export const IntenticOsDriveKindSchema = z.enum(["usb", "card", "other"]);
export type IntenticOsDriveKind = z.infer<typeof IntenticOsDriveKindSchema>;

// One removable drive's filesystem (a partition, or the whole stick when it has none) as `ic os drives list --json`
// says it: `device` is what the other drive verbs take, `label` the name it was given (null for none), `size` in bytes,
// `filesystem` as Linux names it (`vfat`, `exfat`, `ntfs`, `ext4`), `mountedAt` where it is open (null while it is
// not), `model` what the drive says it is. The machine's own disks are never listed.
export const IntenticOsDriveSchema = z.object({
    device: z.string(),
    label: z.string().nullable(),
    size: z.number().int().nonnegative(),
    filesystem: z.string().nullable(),
    mountedAt: z.string().nullable(),
    readOnly: z.boolean(),
    model: z.string().nullable(),
    kind: IntenticOsDriveKindSchema,
});
export type IntenticOsDrive = z.infer<typeof IntenticOsDriveSchema>;
export const IntenticOsDrivesSchema = z.object({ drives: z.array(IntenticOsDriveSchema) });
export type IntenticOsDrives = z.infer<typeof IntenticOsDrivesSchema>;

// `ic os drives import … --json` prints one of these every few seconds while it copies, then the result last.
export const IntenticOsDriveImportProgressSchema = z.object({
    progress: z.object({ bytes: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
});
export type IntenticOsDriveImportProgress = z.infer<typeof IntenticOsDriveImportProgressSchema>;

// What was copied: from which drive, into which sandbox, the folder inside it (`/work/Imports/<label>-<date>`), and how
// many bytes in how many files.
export const IntenticOsDriveImportSchema = z.object({
    device: z.string(),
    sandbox: z.string(),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
});
export type IntenticOsDriveImport = z.infer<typeof IntenticOsDriveImportSchema>;

// The pieces a caller hands ic as positionals and flag values, checked here before they reach its command line: none may
// begin with a hyphen (it would be a flag), and none is a path out of where it belongs. An SSID is anything a network
// broadcasts, so it goes after `--` instead.
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const XKB_NAME = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,63}$/;
const BLOCK_DEVICE = /^\/dev\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SANDBOX_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// An SSID is at most 32 bytes, in whatever characters the network broadcasts.
export const IntenticOsSsidSchema = z
    .string()
    .min(1)
    .refine((ssid) => new TextEncoder().encode(ssid).length <= 32, "a Wi-Fi network's name, at most 32 bytes");
export const IntenticOsDisplayNameSchema = z.string().regex(OUTPUT_NAME, "a screen's connector name, like HDMI-A-1");
export const IntenticOsXkbNameSchema = z.string().regex(XKB_NAME, "an xkb layout or variant name, like de or nodeadkeys");
export const IntenticOsBlockDeviceSchema = z.string().regex(BLOCK_DEVICE, "a drive's device, like /dev/sdb1");
export const IntenticOsSandboxSlugSchema = z.string().regex(SANDBOX_SLUG, "a sandbox's slug").refine((slug) => !slug.includes(".."), "a sandbox's slug");
// A folder inside the sandbox's /work: relative, no `..`, no leading slash or hyphen.
export const IntenticOsImportPathSchema = z
    .string()
    .min(1)
    .max(255)
    .refine(
        (path) => !path.startsWith("/") && !path.startsWith("-") && path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
        "a folder inside the sandbox's /work, like Photos/2026",
    );
export const IntenticOsScaleSchema = z.number().min(0.5).max(4);

/** A mode the way `ic os display set --mode` takes it: `1920x1080@60`, the rate to three decimals at most. */
export const displayModeArg = (mode: IntenticOsDisplayMode): string => `${mode.width}x${mode.height}@${Number(mode.refresh.toFixed(3))}`;

export const icOsNetworkStatusArgs = (): string[] => ["os", "network", "status", "--json"];
export const icOsWifiListArgs = (): string[] => ["os", "network", "wifi", "list", "--json"];
// The password never: it goes on ic's stdin with `--password-stdin`, since a command line is readable by anyone on the
// machine (`ps`). Without one, ic joins a known network or one that asks for none, and exits IC_OS_WIFI_PASSWORD_EXIT
// for one that needs a password.
export const icOsWifiConnectArgs = (ssid: string, withPassword: boolean): string[] => [
    "os",
    "network",
    "wifi",
    "connect",
    ...(withPassword ? ["--password-stdin"] : []),
    "--",
    IntenticOsSsidSchema.parse(ssid),
];
export const icOsWifiForgetArgs = (ssid: string): string[] => ["os", "network", "wifi", "forget", "--", IntenticOsSsidSchema.parse(ssid)];
export const icOsWifiRadioArgs = (on: boolean): string[] => ["os", "network", "wifi", on ? "on" : "off"];

export const icOsSoundStatusArgs = (): string[] => ["os", "sound", "status", "--json"];
// At least one of the two: a volume 0-100, and muted or not. Answers with the status after (`--json`).
export const icOsSoundSetArgs = (change: { readonly volume?: number; readonly muted?: boolean }): string[] => {
    const args = ["os", "sound", "set"];
    if (change.volume !== undefined) {
        args.push("--volume", String(percent.parse(Math.round(change.volume))));
    }
    if (change.muted !== undefined) {
        args.push(change.muted ? "--mute" : "--unmute");
    }
    if (args.length === 3) {
        throw new Error("a sound change names a volume, muted, or both");
    }
    return [...args, "--json"];
};
export const icOsSoundOutputsArgs = (): string[] => ["os", "sound", "outputs", "--json"];
export const icOsSoundOutputArgs = (id: number): string[] => ["os", "sound", "output", String(z.number().int().nonnegative().parse(id))];

export const icOsDisplayListArgs = (): string[] => ["os", "display", "list", "--json"];
export const icOsDisplaySetArgs = (output: string, change: { readonly mode?: IntenticOsDisplayMode; readonly scale?: number }): string[] => {
    const args = ["os", "display", "set", IntenticOsDisplayNameSchema.parse(output)];
    if (change.mode !== undefined) {
        args.push("--mode", displayModeArg(IntenticOsDisplayModeSchema.parse(change.mode)));
    }
    if (change.scale !== undefined) {
        args.push("--scale", String(IntenticOsScaleSchema.parse(change.scale)));
    }
    if (args.length === 4) {
        throw new Error("a display change names a mode, a scale, or both");
    }
    return args;
};

export const icOsKeyboardStatusArgs = (): string[] => ["os", "keyboard", "status", "--json"];
export const icOsKeyboardLayoutsArgs = (): string[] => ["os", "keyboard", "layouts", "--json"];
export const icOsKeyboardSetArgs = (layout: string, variant?: string): string[] => [
    "os",
    "keyboard",
    "set",
    IntenticOsXkbNameSchema.parse(layout),
    ...(variant === undefined ? [] : ["--variant", IntenticOsXkbNameSchema.parse(variant)]),
];

export const icOsDrivesListArgs = (): string[] => ["os", "drives", "list", "--json"];
export const icOsDriveImportArgs = (device: string, sandbox: string, path?: string): string[] => [
    "os",
    "drives",
    "import",
    IntenticOsBlockDeviceSchema.parse(device),
    "--to",
    IntenticOsSandboxSlugSchema.parse(sandbox),
    ...(path === undefined ? [] : ["--path", IntenticOsImportPathSchema.parse(path)]),
    "--json",
];
export const icOsDriveEjectArgs = (device: string): string[] => ["os", "drives", "eject", IntenticOsBlockDeviceSchema.parse(device)];
