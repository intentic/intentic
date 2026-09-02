import { z } from "zod";
import { NeedsActionSchema } from "./needs-action.js";

/* AN ARRIVAL: something coming INTO this sandbox, whatever it came from and whatever it is made of.
 *
 * There used to be three of these, each with its own schemas, its own routes and its own card, and the split
 * was by ARTIFACT: a `sandbox.toml` had one surface, an environment bundle a second, a foreign assistant's
 * home directory a third. That is the wrong axis. The owner's question is never "which of your three import
 * features is this" — it is "I have a thing, take what is safe from it" — and the three artifacts answer it
 * with the same four moves: read the thing, show what would land, take the ticked rows, say what is left.
 *
 * So there is ONE pipeline, and the artifact is a parser:
 *
 *   source  →  plan   (items the owner ticks, refused lines, needsAction said BEFORE anything writes)
 *           →  apply  (the ticked ids, against a plan RE-DERIVED from the held bytes)
 *           →  report (what landed, what did not and why, what still needs a person)
 *
 * WHAT THE MERGE FIXED, beyond three of everything: the bundle door was the only one that WROTE ON FILE PICK.
 * It is also the most destructive of the three — a bundle lands over a workspace rather than beside it — so
 * the one arrival most deserving of a preview was the one without it. Sharing the pipeline is what gave it
 * one, and what makes "untick the 6 GB monorepo" a thing an owner can say to a bundle at all.
 *
 * THE OUTBOUND HALF IS NOT HERE. Deriving a definition, packing a bundle and publishing the workspace repo
 * live on definition.ts and schemas/environment.ts, because they answer the opposite question and share no
 * shape with this one. */

// Which of the four things this is. The two assistants are separate members rather than one "foreign": the
// checklist badges the source by name, and an owner who packed a Hermes folder should read the word Hermes.
export const ArrivalSourceSchema = z.enum(["definition", "bundle", "hermes", "openclaw"]);
export type ArrivalSource = z.infer<typeof ArrivalSourceSchema>;

// The subset a foreign assistant's home directory can be. Narrower than ArrivalSource on purpose: a connected
// computer is scanned for these two and never for a bundle, which is a file, not a setup.
export const AssistantSourceSchema = z.enum(["hermes", "openclaw"]);
export type AssistantSource = z.infer<typeof AssistantSourceSchema>;

/* WHAT AN ITEM BECOMES HERE, not what it was there. The apply loop dispatches on this and the checklist
 * groups by it, so an owner reads "3 skills, 2 connections" rather than a foreign directory listing or a tar
 * table of contents. One enum across all four sources, which is what makes the union honest: a repository is
 * a `repo` whether it arrived as a remote to clone (definition) or as a git dir in a tar (bundle), and the
 * owner ticking it means the same thing either way. */
export const ArrivalGroupSchema = z.enum([
    // The /work tree as a whole, cloned from the remote a definition's `[workspace]` names.
    "workspace",
    // One repository: cloned from its remote, or unpacked with its real git dir from a bundle.
    "repo",
    // Loose files landing in /work: a bundle's workspace bytes, an assistant's notes folder.
    "files",
    // Transcripts, checkpoint timelines, ledgers. Bundle-only — nothing else can reference them.
    "history",
    // The overlay Dockerfile.
    "environment",
    // One connection, landing unauthenticated unless its secret travelled.
    "capability",
    // The agent settings that differ from their defaults.
    "settings",
    // A merge into CLAUDE.md / AGENTS.md.
    "memory",
    "skill",
    "automation",
    // One credential VALUE, and the only group gated behind the apply's second consent.
    "secret",
]);
export type ArrivalGroup = z.infer<typeof ArrivalGroupSchema>;

/* ONE ROW OF THE CHECKLIST. Two flags rather than one, because the four sources fail an item for two
 * genuinely different reasons and collapsing them would lose the one the owner can act on:
 *
 *   `applicable: false`  the target already holds this, so it CANNOT be ticked. A definition and a bundle
 *                        land beside what is there, never over it, so an existing repo directory or
 *                        capability id greys its row and prints the reason.
 *   `recommended: false` it can be ticked and the reader should look first. An adapter's judgment about a
 *                        server URL pointing at the old machine, or an env key that reads as tuning.
 *
 * A source that has no use for one of them fills it constantly: a definition recommends everything it can
 * apply, an assistant adapter refuses inside its own walk rather than emitting inapplicable rows. */
export const ArrivalItemSchema = z.object({
    /* Deterministic and derived from the artifact ("repo:intentic", "skill:weather", "bundle:history"), which
     * is the whole reason the apply may re-derive: the ids the owner ticked name the same items in the
     * second derivation as in the one the browser rendered. */
    id: z.string(),
    group: ArrivalGroupSchema,
    // The checklist line, in plain words: "Repository intentic", "Skill, weather", "Workspace files".
    label: z.string(),
    detail: z.string().optional(),
    applicable: z.boolean(),
    // Why it cannot be ticked. Present exactly when `applicable` is false.
    reason: z.string().optional(),
    recommended: z.boolean(),
    /* Names of the secrets this row would store — never values. Non-empty rows only move when the apply
     * carries `includeSecrets`; the report names what stayed behind rather than pretending it landed. */
    secrets: z.array(z.string()),
});
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;

export const ArrivalPlanSchema = z.object({
    source: ArrivalSourceSchema,
    /* Names the held artifact for the apply call. Minted per plan; a new plan replaces the held one, because
     * an owner changing their mind is the ordinary case and not a conflict. */
    token: z.string(),
    // What the artifact calls itself: a definition's `name`, a bundle's source sandbox. For the reader only.
    name: z.string().optional(),
    items: z.array(ArrivalItemSchema),
    /* Whether this artifact holds credential VALUES at all, which is what decides whether the apply's second
     * consent is even a question. A definition is false by construction (it carries names, never values); a
     * bundle is whatever its owner chose at export; an assistant's home directory is true whenever any row
     * names a secret. The card asks with a toggle only when this is true, so the ordinary arrival is not made
     * to answer a question about credentials that do not exist. */
    carriesSecrets: z.boolean(),
    // What the reader saw and will not offer at all: sessions, logs, pairing state, a tar entry this daemon
    // refuses to write. Listed rather than silent.
    refused: z.array(z.string()),
    // What is already known not to move mechanically, surfaced at PREVIEW time so the owner ticks with open
    // eyes and again on the report.
    needsAction: z.array(NeedsActionSchema),
});
export type ArrivalPlan = z.infer<typeof ArrivalPlanSchema>;

export const ArrivalApplySchema = z.object({
    token: z.string(),
    // The ticked ids. Ids the re-derived plan does not contain are ignored rather than erroring: the artifact
    // is the truth, and a stale checklist must not block the items that still exist.
    items: z.array(z.string()),
    /* The owner's explicit consent to move credential VALUES, asked once, on the inbound side, for every
     * source. It used to be asked at EXPORT time for a bundle and at APPLY time for an assistant, which is
     * the same question in two places with two different answers about who is consenting to what. */
    includeSecrets: z.boolean(),
});
export type ArrivalApply = z.infer<typeof ArrivalApplySchema>;

export const ArrivalReportSchema = z.object({
    applied: z.array(z.object({ id: z.string(), group: ArrivalGroupSchema, label: z.string() })),
    // Ticked and did not land, each with its reason. Distinct from `refused` and from inapplicable rows,
    // which were never attempted.
    failed: z.array(z.object({ id: z.string(), label: z.string(), error: z.string() })),
    refused: z.array(z.string()),
    needsAction: z.array(NeedsActionSchema),
});
export type ArrivalReport = z.infer<typeof ArrivalReportSchema>;

/* ONE OF THE OWNER'S OWN COMPUTERS, as an arrival source that needs no packing at all: the daemon walks the
 * machine's home folder over the socket it already holds. Read on the card's first render for every enrolled
 * machine, so the offer appears before the owner has read a single instruction.
 *
 * `found` absent means "connected, and nothing to bring in from here", which is a real answer worth rendering
 * quietly rather than an error: the machine may simply not be the one the assistant runs on. */
export const ArrivalHostSchema = z.object({
    id: z.string(),
    online: z.boolean(),
    found: AssistantSourceSchema.optional(),
    // Why this machine cannot be read right now, when it cannot: asleep, or its own refusal, in its words.
    detail: z.string().optional(),
});
export type ArrivalHost = z.infer<typeof ArrivalHostSchema>;
export const ArrivalHostsSchema = z.object({ hosts: z.array(ArrivalHostSchema) });

// Read a setup off a connected computer instead of an upload. Answers with a plan exactly as the upload door
// does; everything after this point is identical whichever door the arrival came through.
export const ArrivalScanSchema = z.object({ host: z.string().min(1) });
export type ArrivalScan = z.infer<typeof ArrivalScanSchema>;
