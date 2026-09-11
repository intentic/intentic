import { z } from "zod";
import { NeedsActionSchema } from "../policy/needs-action.js";
import { CapabilitySchema } from "../schemas/capabilities.js";
import { SandboxSettingsSchema } from "../schemas/settings.js";

// A definition is the reproducible half of a sandbox: repos as remotes, connections as shapes, the overlay as source
// needing approval, secrets as names, never raw bytes (that's a bundle). Wire format is TOML (sandbox.toml); applying
// it never bypasses consent, no credential ever travels.

// One repository by reference: the workspace id, its clone remote, and an optional branch. No remote means it's
// omitted, not invented.
export const DefinitionRepositorySchema = z.strictObject({
    // Workspace-relative repo id ("intentic", "clients/foo"), the same id the wire {repo} routes use.
    id: z.string().min(1),
    // The clone URL, verbatim from the source repo's own remote.
    remote: z.string().min(1),
    // The branch to check out; absent means the remote's default.
    ref: z.string().optional(),
});
export type DefinitionRepository = z.infer<typeof DefinitionRepositorySchema>;

// The /work git repo, by reference: tracks the owner's authored content (notes, skills, personas, automations, designs,
// approvals). With a remote it's referenceable like any repo; without one it's omitted, not invented.
export const DefinitionWorkspaceSchema = z.strictObject({
    // The clone URL, verbatim from the workspace repo's own remote.
    remote: z.string().min(1),
    // The branch to check out; absent means the remote's default.
    ref: z.string().optional(),
});
export type DefinitionWorkspace = z.infer<typeof DefinitionWorkspaceSchema>;

export const DefinitionEnvironmentSchema = z.strictObject({
    // The image the overlay extends, informational only; the target composes against its own base.
    baseImage: z.string().optional(),
    // The owner-approved overlay source, not the composed file or approval hash; consent doesn't travel with it.
    dockerfile: z.string().optional(),
});
export type DefinitionEnvironment = z.infer<typeof DefinitionEnvironmentSchema>;

// `.partial()` keeps each field's own `.default()`, so an absent key would still fill in at today's value. Unwrapping
// first keeps it truly absent, so apply merges over the target's settings.
// Strips both ZodDefault and ZodPrefault, in a loop: a field can be one wrapped inside the other.
const bareField = (field: z.ZodType): z.ZodType => {
    let inner = field;
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault) {
        inner = inner.unwrap() as z.ZodType;
    }
    return inner;
};

const definitionSettings = (): z.ZodType<Partial<z.infer<typeof SandboxSettingsSchema>>> => {
    const shape = Object.fromEntries(Object.entries(SandboxSettingsSchema.shape).map(([key, field]) => [key, bareField(field).optional()]));
    return z.strictObject(shape).prefault({}) as unknown as z.ZodType<Partial<z.infer<typeof SandboxSettingsSchema>>>;
};

export const SandboxDefinitionSchema = z.strictObject({
    // Bumped when the layout changes in a way an older daemon would misread; refused rather than guessed at.
    schemaVersion: z.literal(1),
    // What the source sandbox was called, for the reader; never used to authorize anything.
    name: z.string().optional(),
    environment: DefinitionEnvironmentSchema.prefault({}),
    // The workspace repo, when it has a remote; absent is the ordinary unpublished state, not an error.
    workspace: DefinitionWorkspaceSchema.optional(),
    repositories: z.array(DefinitionRepositorySchema).prefault([]),
    // Each connection in full (id, kind, config), never its credential; lands unauthenticated, waiting for one.
    capabilities: z.array(CapabilitySchema).prefault([]),
    // Secret names only, what the target should ask its owner for; values never enter a definition.
    secrets: z.array(z.string()).prefault([]),
    // Partial on purpose: states decisions only, a flag not mentioned keeps the target's own default.
    settings: definitionSettings(),
});
export type SandboxDefinition = z.infer<typeof SandboxDefinitionSchema>;

// A "do this by hand" line (bold subject, instruction detail), shared with the arrival surface.
export { NeedsActionSchema, type NeedsAction } from "../policy/needs-action.js";

// What GET /definition answers: the emitted TOML, plus anything the derivation couldn't express (e.g. a repo with no
// remote), listed rather than silent.
export const DefinitionExportSchema = z.object({
    toml: z.string(),
    omitted: z.array(NeedsActionSchema),
});
export type DefinitionExport = z.infer<typeof DefinitionExportSchema>;

// Applying a definition happens through arrival.ts's shared pipeline (ArrivalPlan -> ArrivalApply -> ArrivalReport),
// not a plan/apply/report trio here. This file only derives the document and diffs against it.

// Where this sandbox stands relative to a definition: one line per difference, empty when they agree, computable since
// the emitter is deterministic.
export const DefinitionDiffSchema = z.object({
    differences: z.array(NeedsActionSchema),
});
export type DefinitionDiff = z.infer<typeof DefinitionDiffSchema>;

// Publishing /work to a remote (so [workspace] can name it) is its own route, not a side effect of export: an outward
// act needs its own confirmation, and deriving a document must stay read-only.
export const WorkspacePublishSchema = z.object({
    // Given, an existing repo's URL is wired up and pushed to; nothing new is created.
    remote: z.string().min(1).optional(),
    // The repo to create when remote is absent; defaults to the sandbox's own name.
    name: z.string().min(1).optional(),
    // The account/org to create it under; absent means the authenticated user. Ignored when remote is given.
    owner: z.string().min(1).optional(),
});
export type WorkspacePublish = z.infer<typeof WorkspacePublishSchema>;

// Where the workspace now lives, and what a definition will name; created distinguishes making a repo from wiring up
// one you gave.
export const WorkspacePublishResultSchema = z.object({
    remote: z.string(),
    branch: z.string(),
    created: z.boolean(),
});
export type WorkspacePublishResult = z.infer<typeof WorkspacePublishResultSchema>;

// What the card shows before publishing: whether /work has a remote, and which connected hosts could make one.
// Read-only, so the button can name the host directly.
export const WorkspaceRemoteSchema = z.object({
    remote: z.string().optional(),
    branch: z.string().optional(),
    // Hostnames of connected git accounts, in try order; empty means the owner must connect one or paste a URL.
    hosts: z.array(z.string()),
});
export type WorkspaceRemote = z.infer<typeof WorkspaceRemoteSchema>;

// A bundle is definition + state: the manifest embeds the same definition GET /definition emits; the tar carries what
// no definition can reference. One schema, two doors, so the formats never disagree. An unknown version is refused.
export const BundleManifestSchema = z.object({
    // Bumped when the layout changes in a way an older daemon would misread; refused rather than guessed at.
    version: z.literal(3),
    // Where it came from, for the report's first line; never used to authorize anything. The CONTAINER's name
    // (SANDBOX_NAME, `intentic-sandbox-sandbox-<id>`), so the block is absent on a headless daemon that has none.
    sandbox: z.object({ name: z.string() }).optional(),
    // How the source presented itself: what its owner called it and the logo the switcher draws. Its own key rather
    // than two more fields on `sandbox`, because these are platform rows (`sandbox.name` / `sandbox.image`) held
    // nowhere under /work or /history, and either can be known when the container name is not — hanging them off
    // `sandbox` would have made a sandbox's presentation ride on an unrelated string being set, and loosening that
    // block's `name` to allow it would have shrunk a shipped surface. Without this a move landed a workspace called
    // "workspace" wearing a "W" monogram, the source's identity left behind. A bundle is the only artifact that
    // crosses both, so it carries them and the report hands them straight back, in this same shape, for the caller
    // holding the owner session to apply.
    presentation: z
        .object({
            name: z.string().optional(),
            // A data URL, same shape and 150 KB ceiling the platform's own ImageDataUrlSchema enforces on the way in.
            image: z.string().optional(),
        })
        .optional(),
    createdAt: z.number(),
    // The owner's export choice, used only to explain gaps; the restorer re-derives from the manifests instead.
    secrets: z.boolean(),
    // Repos whose git dir rides along, by id, including ones with no remote to be named by. root isn't listed.
    repos: z.array(z.string()),
    // Exactly what a definition export emits, so restore reasons over the same facts either door gives.
    definition: SandboxDefinitionSchema,
    // Every path class left out, with a note when there is one; a silent skip becomes an actionable list.
    excluded: z.array(z.object({ path: z.string(), portability: z.string(), note: z.string().optional() })),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
