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
