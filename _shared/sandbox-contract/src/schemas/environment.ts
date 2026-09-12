// environment: the overlay Dockerfile extending the sandbox image
import { z } from "zod";
// The approved file is daemon-composed (pinned FROM + capability fragments + the owner-approved custom section). Status
// is derived, never stored:
// applied: sha256(approved) === appliedHash.
// pending rebuild: approved present but hashes differ.
// proposed: proposal present with a hash different from custom's.

const environmentFileSchema = z.object({ content: z.string(), hash: z.string() });
// What the live container has that the image did not put there; anything outside /work dies with the container. Two
// channels, apt's own log and an mtime sweep, because dpkg-unpacked files keep archive mtimes invisible to the sweep.
export const EnvironmentDriftSchema = z.object({
    // PID 1's start; a snapshot whose bornAt differs from the running container's means no drift, not stale drift.
    bornAt: z.number(),
    // When the probe ran.
    at: z.number(),
    // Debian packages installed since the container was born, from /var/log/dpkg.log.
    apt: z.array(z.string()),
    // System paths (outside /work) newer than the container, collapsed so a browser download is one entry.
    paths: z.array(z.string()),
});
export type EnvironmentDrift = z.infer<typeof EnvironmentDriftSchema>;
// How a runtime install was made; decides whether the daemon can draft a Dockerfile step mechanically
// (apt/cargo/npm/rustup-target) or must surface it for a person (pip, or "other": a curl|sh that could embed anything).
export const RuntimeInstallKindSchema = z.enum(["apt", "pip", "cargo", "npm", "rustup-target", "playwright", "gem", "pipx", "go", "other"]);
export type RuntimeInstallKind = z.infer<typeof RuntimeInstallKindSchema>;
// One tool's install history across sessions: a session that retries an install needed it once (the unit of
// recurrence). Persisted under /work so it survives container recreates.
export const RuntimeInstallSchema = z.object({
    tool: z.string(),
    kind: RuntimeInstallKindSchema,
    // Distinct conversation ids that installed it, capped; length is the recurrence count that gates drafting.
    sessions: z.array(z.string()),
    // The most recent install commands, capped, secrets already masked to references by the harness.
    commands: z.array(z.string()),
    firstAt: z.number(),
    lastAt: z.number(),
    count: z.number(),
    // The owner rejected an auto-drafted step for this tool: never propose it again until this is cleared.
    declinedAt: z.number().optional(),
});
export type RuntimeInstall = z.infer<typeof RuntimeInstallSchema>;
export const RuntimeInstallsFileSchema = z.object({
    installs: z.array(RuntimeInstallSchema),
    // The last drift snapshot, persisted so a daemon restart does not blank the card until the next sweep.
    drift: EnvironmentDriftSchema.optional(),
});
export type RuntimeInstallsFile = z.infer<typeof RuntimeInstallsFileSchema>;
// Ledger entry as the Environment card shows it: recurrence joined with whether it's present in the live container
// (drift-corroborated), drafted, or declined.
export const EnvironmentRecurringSchema = z.object({
    tool: z.string(),
    kind: RuntimeInstallKindSchema,
    sessions: z.number(),
    lastAt: z.number(),
    live: z.boolean(),
    drafted: z.boolean().optional(),
    declined: z.boolean().optional(),
    // Step that would bake this tool; absent means the fix needs judgement and the card offers an agent instead.
    step: z.string().optional(),
});
export type EnvironmentRecurring = z.infer<typeof EnvironmentRecurringSchema>;
// Owner's decision on one recurring-install entry:
// adopt: writes the tool's overlay draft now.
// dismiss: tombstones it so nothing proposes it again.
// restore: undoes a dismissal.
export const EnvironmentRuntimeDecisionSchema = z.object({
    tool: z.string().min(1),
    decision: z.enum(["adopt", "dismiss", "restore"]),
});
export type EnvironmentRuntimeDecision = z.infer<typeof EnvironmentRuntimeDecisionSchema>;
// A base that was built on the host rather than published, which is what a dogfooding checkout runs: the recipe is
// rebuilt from that checkout, and a registry update would move the sandbox off it. `root` is the checkout's path out
// there (SANDBOX_DEV_ROOT), absent on a sandbox that was handed a local image without one.
export const EnvironmentLocalImageSchema = z.object({ base: z.string(), root: z.string().optional() });
export type EnvironmentLocalImage = z.infer<typeof EnvironmentLocalImageSchema>;
export const EnvironmentSchema = z.object({
    proposal: environmentFileSchema.optional(),
    // The owner-approved agent-written custom section (.intentic/config/environment.custom.Dockerfile).
    custom: environmentFileSchema.optional(),
    approved: environmentFileSchema.optional(),
    // sha256 of the overlay the running container was built from (SANDBOX_ENVIRONMENT_HASH); absent = stock image.
    appliedHash: z.string().optional(),
    // config.sandbox.name, the UI derives the rebuild one-liner's slug from it.
    container: z.string().optional(),
    // What the live container has beyond the image; absent until this container's first sweep.
    drift: EnvironmentDriftSchema.optional(),
    // Runtime installs worth the owner's attention: recurring across sessions, or present-and-doomed right now.
    recurring: z.array(EnvironmentRecurringSchema).optional(),
    // Absent on a sandbox running a published image, which is every sandbox but a dogfooding one.
    localImage: EnvironmentLocalImageSchema.optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentApproveSchema = z.object({ hash: z.string().min(1) });
// What the sandbox has, not how it was built. Names, grouping and rationale come from the recipe; presence and version
// come from probing the sandbox itself, so a version is never guessed, only reported when probed.

const environmentToolSchema = z.object({
    // The binary as it is invoked (`rustc`, `ffmpeg`), because that is what somebody types next.
    name: z.string(),
    // What the binary itself reports, absent when it is not installed (yet) or answers no version flag.
    version: z.string().optional(),
});
export const EnvironmentItemSchema = z.object({
    id: z.string(),
    // The block's own name, how the thing is referred to, not the packages it happens to install.
    name: z.string(),
    // Why it is here, and whether the reader may remove it:
    // custom: an agent asked for it and the owner approved it for this workspace.
    // capability: the cost of a capability the owner turned on.
    // base: comes with every sandbox; nobody's decision.
    origin: z.enum(["custom", "capability", "base"]),
    // Which capability/extension/pack pulled it in, for an origin the reader did not choose item by item.
    originLabel: z.string().optional(),
    // Observed, not inferred:
    // active: the probe found it.
    // after-rebuild: the recipe has it, the container does not yet.
    // awaiting-approval: it is in a proposal nobody has approved yet.
    state: z.enum(["active", "after-rebuild", "awaiting-approval"]),
    // Every binary this block puts on PATH, with its version. Usually one; a toolchain is several.
    tools: z.array(environmentToolSchema),
    // Further packages the block installs with no command (libraries, headers); a count, not a list.
    extras: z.number().optional(),
    // One standalone line, from the block's opening comment, the part everyone reads.
    purpose: z.string().optional(),
    // Full comment as prose, overlapping `purpose` by design rather than continuing past it.
    detail: z.string().optional(),
    // The block's own instruction lines, for the reader who wants to see exactly what runs.
    commands: z.string().optional(),
});
export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;
export const EnvironmentContentsSchema = z.object({ items: z.array(EnvironmentItemSchema) });
export type EnvironmentContents = z.infer<typeof EnvironmentContentsSchema>;
// A sandbox is four stores: /work, /history, the container, and the AI-provider credential root. A bundle carries only
// the first two (WORKSPACE_STATE_FILES/HISTORY_STATE_FILES); it cannot rebuild the container or credentials, so
// importing one is a report, not a claim of equivalence. Only the outbound half is here; inbound is one of arrival.ts's
// four sources.

// One export in the daemon's export directory, the artifact a bundle is, not the request that made it; every field is
// read off that file. `status` comes from its extension (.part/.tar.gz/.failed), `bytes` from its own size.
export const BundleExportSchema = z.object({
    // Finished filename: the id in every route, timestamped, marked `-with-secrets` when relevant.
    name: z.string(),
    status: z.enum(["packing", "ready", "failed"]),
    // Bytes written so far while packing; the finished size once ready.
    bytes: z.number(),
    // mtime: when packing ended for a finished bundle, when it last made progress for a live one.
    createdAt: z.number(),
    secrets: z.boolean(),
    // Why it stopped, for a failed one. Read from the .failed marker's own contents.
    error: z.string().optional(),
});
export type BundleExport = z.infer<typeof BundleExportSchema>;
export const BundleExportsSchema = z.object({ exports: z.array(BundleExportSchema) });
