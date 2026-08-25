import { z } from "zod";
import { DefinitionActionSchema } from "./definition-action.js";
import { CapabilitySchema, SandboxSettingsSchema } from "./schemas.js";

/* THE SANDBOX DEFINITION: the declarable SHAPE of a sandbox, split off from its state.
 *
 * A bundle (portability section of schemas.ts) moves everything a sandbox holds; this is the half of it that
 * is a REFERENCE to a source of truth rather than bytes only this sandbox has: which repos (as remotes a
 * target can clone), which connections (as shapes a target re-authenticates), which overlay steps (as source
 * a target's owner approves), which secrets (as NAMES a target asks for), which agent settings. Everything
 * here can be reproduced against the world; everything a bundle carries beyond it (transcripts, checkpoint
 * timelines, unpushed branches, ledgers) cannot, which is the line between the two formats.
 *
 * ON THE WIRE AND ON DISK IT IS TOML (`sandbox.toml`), hand-writable and diffable; these schemas are what the
 * parsed document must satisfy. The choice of a definition never relaxes the consent model: applying one
 * writes the overlay as a PROPOSAL for the owner's approval gate, lands capabilities unauthenticated, and
 * never carries a credential value, so a definition is safe to publish in a way a bundle never is.
 */

// One repository, by reference: the id it lands under in the workspace, where a target clones it from, and
// (optionally) the branch to check out. A repo with NO remote cannot appear here, the exporter reports it as
// omitted instead of inventing a source for bytes only the source sandbox holds.
export const DefinitionRepositorySchema = z.object({
    // Workspace-relative repo id ("intentic", "clients/foo"), the same id the wire {repo} routes use.
    id: z.string().min(1),
    // The clone URL, verbatim from the source repo's own remote.
    remote: z.string().min(1),
    // The branch to check out; absent means the remote's default.
    ref: z.string().optional(),
});
export type DefinitionRepository = z.infer<typeof DefinitionRepositorySchema>;

export const DefinitionEnvironmentSchema = z.object({
    // The image the overlay extends, informational: the target composes against ITS OWN base (see
    // composeEnvironment's baseImageOf), this records what the source was on.
    baseImage: z.string().optional(),
    /* The owner-approved CUSTOM overlay section, as source. Deliberately not the composed file and
     * deliberately without the approval hash: consent does not travel, so an applied definition parks this at
     * the target owner's approval gate rather than executing it. */
    dockerfile: z.string().optional(),
});
export type DefinitionEnvironment = z.infer<typeof DefinitionEnvironmentSchema>;

/* The settings section: every SandboxSettings field, optional, WITHOUT its default. `.partial()` alone keeps
 * each field's `.default()`, so a document naming two flags would parse into the whole surface at today's
 * defaults — the opposite of "state only decisions", and it would freeze those defaults into every future
 * apply. Unwrapping first is what makes an absent key STAY absent, so applying merges over the target's own
 * settings and a definition round-trips through parse byte-identically. */
// Both wrapper classes, in a loop: a field can be a default inside a prefault, and either one left on would
// re-materialize its value for an absent key.
const bareField = (field: z.ZodType): z.ZodType => {
    let inner = field;
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault) {
        inner = inner.unwrap() as z.ZodType;
    }
    return inner;
};

const definitionSettings = (): z.ZodType<Partial<z.infer<typeof SandboxSettingsSchema>>> => {
    const shape = Object.fromEntries(Object.entries(SandboxSettingsSchema.shape).map(([key, field]) => [key, bareField(field).optional()]));
    return z.object(shape).prefault({}) as unknown as z.ZodType<Partial<z.infer<typeof SandboxSettingsSchema>>>;
};

export const SandboxDefinitionSchema = z.object({
    // Bumped when the layout changes in a way an older daemon would misread. Refused rather than guessed at,
    // the bundle manifest's own rule.
    schemaVersion: z.literal(1),
    // What the source sandbox was called, for the reader; never used to authorize anything.
    name: z.string().optional(),
    environment: DefinitionEnvironmentSchema.prefault({}),
    repositories: z.array(DefinitionRepositorySchema).prefault([]),
    /* Each connection IN FULL (id, kind, config), not merely named: the manifest they come from carries the
     * SHAPE of a connection and never its credential (workspace-state.ts argues the split on the
     * capabilities.json entry, and the exporter sweeps before reading), so what lands on a target is the card,
     * visibly unauthenticated, waiting for one credential apiece. */
    capabilities: z.array(CapabilitySchema).prefault([]),
    // Secret NAMES only, what the target should ask its owner for. Values never enter a definition.
    secrets: z.array(z.string()).prefault([]),
    // The agent settings that differ from their defaults. Partial on purpose: a definition states decisions,
    // not the whole flag surface, so a flag it does not mention keeps the target's own default.
    settings: definitionSettings(),
});
export type SandboxDefinition = z.infer<typeof SandboxDefinitionSchema>;

// One "do this by hand" line, the same honesty unit ImportReportSchema carries: a subject the UI bolds and a
// detail written as an instruction to the owner. Defined in its own leaf module (definition-action.ts says
// why) and re-exported here, where every consumer of the definition surface finds it.
export { DefinitionActionSchema, type DefinitionAction } from "./definition-action.js";

// What GET /definition answers: the emitted TOML, plus what the derivation could not express (a repo with no
// remote), listed rather than silent, the export's own `excluded` discipline.
export const DefinitionExportSchema = z.object({
    toml: z.string(),
    omitted: z.array(DefinitionActionSchema),
});
export type DefinitionExport = z.infer<typeof DefinitionExportSchema>;

// One appliable piece of a held definition, the checklist row the owner ticks. Mirrors MigrationItemSchema's
// role; the ids are deterministic ("repo:intentic", "capability:github") so the re-derived apply names the
// same items the owner reviewed.
export const DefinitionItemSchema = z.object({
    id: z.string(),
    kind: z.enum(["repo", "capability", "environment", "settings"]),
    label: z.string(),
    detail: z.string().optional(),
    /* False when the target already holds this piece (the repo's directory exists, a capability with that id
     * exists): a definition lands BESIDE what is there, never over it, so an inapplicable item renders greyed
     * with its reason rather than disappearing. */
    applicable: z.boolean(),
    reason: z.string().optional(),
});
export type DefinitionItem = z.infer<typeof DefinitionItemSchema>;

export const DefinitionPlanSchema = z.object({
    // Names the held definition for the apply call. Minted per plan; a new plan replaces the held one.
    token: z.string(),
    name: z.string().optional(),
    items: z.array(DefinitionItemSchema),
    // What is already known not to move mechanically (credentials to enter, an overlay to approve), surfaced
    // at PREVIEW time so the owner ticks with open eyes, the migration surface's rule.
    needsAction: z.array(DefinitionActionSchema),
});
export type DefinitionPlan = z.infer<typeof DefinitionPlanSchema>;

export const DefinitionApplySchema = z.object({
    token: z.string(),
    // The ticked item ids. Ids the re-derived plan does not contain are ignored rather than erroring.
    items: z.array(z.string()),
});
export type DefinitionApply = z.infer<typeof DefinitionApplySchema>;

export const DefinitionReportSchema = z.object({
    applied: z.array(z.object({ id: z.string(), label: z.string() })),
    // Ticked and did not land, each with the reason (a clone that failed, a full disk). Distinct from
    // inapplicable items, which were never attempted.
    failed: z.array(z.object({ id: z.string(), label: z.string(), error: z.string() })),
    needsAction: z.array(DefinitionActionSchema),
});
export type DefinitionReport = z.infer<typeof DefinitionReportSchema>;

// Where this sandbox stands relative to a definition: one line per difference, empty when they agree. The
// drift answer, computable because the emitter is deterministic.
export const DefinitionDiffSchema = z.object({
    differences: z.array(DefinitionActionSchema),
});
export type DefinitionDiff = z.infer<typeof DefinitionDiffSchema>;

/* ---- the bundle manifest, restated on the definition ----
 *
 * A bundle is DEFINITION + STATE: its manifest embeds the same definition `GET /definition` emits, and the
 * tar entries behind it carry what no definition can reference (git dirs, transcripts, ledgers). One schema,
 * two doors, which is what keeps the two formats from drifting into different answers about what an
 * environment IS. Version 2 replaced the ad-hoc `environment` facts block with the definition; a v1 bundle is
 * refused by version rather than guessed at, like any other manifest this daemon cannot read.
 */
export const BundleManifestSchema = z.object({
    // Bumped when the layout changes in a way an older daemon would misread. Refused rather than guessed at.
    version: z.literal(2),
    // Where it came from, for the report's first line. Never used to authorize anything.
    sandbox: z.object({ name: z.string() }).optional(),
    createdAt: z.number(),
    // The owner's export-time choice; the restorer re-derives every decision from the manifests rather than
    // trusting this, and uses it only to explain what is missing.
    secrets: z.boolean(),
    // The declarable shape, exactly what a definition export emits, so the restore report reasons over the
    // same facts either door delivers.
    definition: SandboxDefinitionSchema,
    // Every path class the bundle deliberately left out, with the manifest's own note where it has one. This is
    // what turns "the export skipped things" from a silence into a list the owner can act on.
    excluded: z.array(z.object({ path: z.string(), portability: z.string(), note: z.string().optional() })),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
