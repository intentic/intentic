// environment: the overlay Dockerfile extending the sandbox image
import { z } from "zod";
// The approved file is DAEMON-COMPOSED: pinned FROM + capability fragments + the owner-approved custom section.
// The agent drafts one file per thing it needs (.intentic/config/environment.d/<tool>.Dockerfile, custom-section
// content only, no FROM) with its normal file tools, and the daemon folds those into the single proposal file
// (.intentic/config/environment.Dockerfile) the owner reads. The owner approves it in the browser, which stores it as
// the custom file and recomposes the approved artifact whose sha256 the rebuild executor pins. Both composed
// files are written only when the composition CHANGES, see writeComposed, and the read loop it exists to end.
// Status is derived, never stored:
// applied = sha256(approved) === appliedHash; pending rebuild = approved present but hashes differ; proposed =
// proposal present with a hash different from custom's.

const environmentFileSchema = z.object({ content: z.string(), hash: z.string() });
/* ---- environment DRIFT: what the live container has that the image did not put there ----
 *
 * Anything installed outside /work dies with the container, and transcript mining showed the same tools being
 * reinstalled session after session (cargo-xwin six times, a Windows rustup target eight) before anyone thought
 * to bake them. Drift is the daemon OBSERVING that gap rather than trusting the model to report it: apt installs
 * read from dpkg's own log, everything else from system paths newer than the container itself. Two channels
 * because they are disjoint by construction — dpkg unpacks files with their archive mtimes, so an mtime sweep
 * cannot see apt, and nothing apt does lands under the swept prefixes' hand-installed corners. */
export const EnvironmentDriftSchema = z.object({
    // When this container was created (PID 1's start). A snapshot whose bornAt is not the running container's
    // describes a container that no longer exists, and every reader must treat it as no drift at all.
    bornAt: z.number(),
    // When the probe ran.
    at: z.number(),
    // Debian packages installed since the container was born, from /var/log/dpkg.log.
    apt: z.array(z.string()),
    // System paths (outside /work) newer than the container, collapsed so a browser download is one entry.
    paths: z.array(z.string()),
});
export type EnvironmentDrift = z.infer<typeof EnvironmentDriftSchema>;
// How a runtime install was made, which decides whether the daemon can draft a Dockerfile step for it
// mechanically (apt/cargo/npm/rustup-target) or only surface it for a person to route (pip belongs in a venv or
// a Debian package, "other" is a curl|sh whose replay could embed anything).
export const RuntimeInstallKindSchema = z.enum(["apt", "pip", "cargo", "npm", "rustup-target", "playwright", "gem", "pipx", "go", "other"]);
export type RuntimeInstallKind = z.infer<typeof RuntimeInstallKindSchema>;
/* One tool's runtime-install history across sessions: the ledger entry behind the recurrence signal. Sessions
 * are the unit of recurrence — a session that retries an install five times needed it once — and the entry
 * survives container recreates (the file lives under /work), which is exactly what makes "installed again in a
 * fresh container" observable at all. */
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
// A ledger entry as the Environment card shows it: recurrence joined with whether the install is present in the
// LIVE container (drift-corroborated), already drafted for approval, or previously declined.
export const EnvironmentRecurringSchema = z.object({
    tool: z.string(),
    kind: RuntimeInstallKindSchema,
    sessions: z.number(),
    lastAt: z.number(),
    live: z.boolean(),
    drafted: z.boolean().optional(),
    declined: z.boolean().optional(),
});
export type EnvironmentRecurring = z.infer<typeof EnvironmentRecurringSchema>;
export const EnvironmentSchema = z.object({
    proposal: environmentFileSchema.optional(),
    // The owner-approved agent-written custom section (.intentic/config/environment.custom.Dockerfile).
    custom: environmentFileSchema.optional(),
    approved: environmentFileSchema.optional(),
    // sha256 of the overlay the running container was built from (SANDBOX_ENVIRONMENT_HASH); absent = stock image.
    appliedHash: z.string().optional(),
    // config.sandbox.name, the UI derives the rebuild one-liner's slug from it.
    container: z.string().optional(),
    // What the live container has that the image did not put there; absent until the first sweep of this container.
    drift: EnvironmentDriftSchema.optional(),
    // Runtime installs worth the owner's attention: recurring across sessions, or present-and-doomed right now.
    recurring: z.array(EnvironmentRecurringSchema).optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentApproveSchema = z.object({ hash: z.string().min(1) });
/* ---- environment CONTENTS: what the sandbox has, as opposed to how it was built ----
 *
 * The overlay above answers "what was added on top, and do you approve it?". Nobody opens the Environment tab
 * asking that, they ask "can this sandbox compile my Rust app / transcode a video / drive a browser?", and a
 * build recipe is a bad answer to it: it is install plumbing, it names packages rather than abilities, and it is
 * only the DELTA, so an inventory read off it alone would claim a sandbox has ffmpeg and no Node.
 *
 * So this is a second read of the same sandbox, and its authority is different in a way that matters: NAMES,
 * GROUPING and RATIONALE come from the recipe (which is where the agent wrote them), while PRESENCE and VERSION
 * come from asking the environment itself. That split is what makes it honest. A version is never parsed out of
 * an install line, half the entries pin nothing, and a pinned number is a lie the moment something is approved
 * but not yet rebuilt, so an item whose tools cannot be probed carries no version at all rather than a guess.
 * And presence is OBSERVED, which is what makes per-item state exact without diffing anything: an item the
 * recipe contains and the probe cannot find is precisely one that arrives with the next rebuild.
 */

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
    /* WHY IT IS HERE, which is also whether the reader may remove it: `custom` is what an agent asked for and the
     * owner approved for this workspace, `capability` is the cost of a capability they turned on, `base` comes
     * with every sandbox and is nobody's decision. */
    origin: z.enum(["custom", "capability", "base"]),
    // Which capability/extension/pack pulled it in, the answer to "why do I have this?" for an origin the
    // reader did not choose item by item.
    originLabel: z.string().optional(),
    // Observed, not inferred: `active` means the probe found it, `after-rebuild` that the recipe has it and the
    // container does not, `awaiting-approval` that it is in a proposal nobody has approved yet.
    state: z.enum(["active", "after-rebuild", "awaiting-approval"]),
    // Every binary this one block puts on PATH, with the version each reports. Usually one; a toolchain is several.
    tools: z.array(environmentToolSchema),
    // How many further packages the block installs that are not commands anyone runs (libraries, headers). A
    // count rather than a list: eleven rows of `libssl-dev` is noise, "+11 packages" is the same fact.
    extras: z.number().optional(),
    // One standalone line, from the block's opening comment, the part everyone reads.
    purpose: z.string().optional(),
    /* That comment in full, as prose, absent when the line above already is the whole of it. NOT the remainder
     * after the line: `purpose` is a summary of this (a parenthetical dropped, an over-long sentence cut back to
     * its claim), so the two overlap by design and it is the reader's view that picks one. Long, the rationale
     * for a toolchain runs to paragraphs, so it lives behind a disclosure rather than on the row. */
    detail: z.string().optional(),
    // The block's own instruction lines, for the reader who wants to see exactly what runs.
    commands: z.string().optional(),
});
export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;
export const EnvironmentContentsSchema = z.object({ items: z.array(EnvironmentItemSchema) });
export type EnvironmentContents = z.infer<typeof EnvironmentContentsSchema>;
/* ---- portability: exporting a sandbox's environment ----
 *
 * A sandbox is four stores, not one: `/work` (the workspace and the daemon's manifests), `/history` (every
 * repo's real git dir, the fleet registry, the ledgers), the CONTAINER (the built overlay image plus the env
 * the run contract replays) and the AI-provider credential root. A bundle carries the first two, declared entry
 * by entry in WORKSPACE_STATE_FILES / HISTORY_STATE_FILES. It cannot carry the other two, and the honest
 * consequence is that taking one in ends in a REPORT rather than a claim of equivalence, the container has no
 * docker socket, so only the host can rebuild the image the overlay describes.
 *
 * The bundle's manifest (BundleManifestSchema) lives in definition.ts beside the sandbox DEFINITION it embeds:
 * a bundle is definition + state, and keeping the two schemas together is what keeps the two export doors from
 * drifting into different answers about what an environment is.
 *
 * ONLY THE OUTBOUND HALF IS HERE. Taking a bundle IN is not a surface of its own any more: it is one of the
 * four sources the arrival pipeline reads (arrival.ts), beside a definition and the two foreign assistants,
 * because all four answer the same question and used to answer it three different ways. */

/* One export sitting in the daemon's export directory, the ARTIFACT a bundle is, rather than the request that
 * produced it. Packing takes minutes over a real workspace, so tying it to a response made it a property of one
 * browser tab: a refresh abandoned the work and left nothing to come back to. It is a file now, and every field
 * below is read off that file rather than remembered anywhere.
 *
 * `status` is derived from the extension (.part / .tar.gz / .failed) and `bytes` is the file's own size, which
 * is what makes a live pack's progress free to report. */
export const BundleExportSchema = z.object({
    // The finished bundle's filename, which is the id in every route, and, once downloaded, the name the owner
    // sees on disk. Carries its own timestamp and a `-with-secrets` marker so it stays self-describing there.
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
