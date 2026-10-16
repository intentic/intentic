import { z } from "zod";
import { PRESET_GROUPS, type PresetGroup, PresetGroupSchema } from "./compliance.js";

// An ORGANISATION'S POLICY as a sandbox holds it (docs/architecture/organisations.md). A sandbox that belongs to an
// organisation is handed this by the platform it is registered with; a personal sandbox never holds one, and nothing
// here applies to it. The daemon is the enforcing copy: a section the policy locks is refused at the daemon's own
// middleware for every caller, the owner and the agent included, and the editor only draws what the daemon says.

// The parts of a sandbox an organisation can take out of its members' hands. Each is a section of the editor's sandbox
// hub (sandboxNav.ts) except `updates`, which is the auto-update switch on Overview. Which daemon routes each one
// covers is policy/org-locks.ts, beside the refusal that reads it.
export const ORG_SECTIONS = [
    "models",
    "agent",
    "environment",
    "secrets",
    "data-protection",
    "extensions",
    "access",
    "areas",
    "personas",
    "updates",
] as const;
export const OrgSectionSchema = z.enum(ORG_SECTIONS);
export type OrgSection = z.infer<typeof OrgSectionSchema>;

// `open`: as in a personal sandbox. `locked`: readable, every change refused. `hidden`: locked, and the editor does not
// show the section at all. Hidden is a fence on what people are shown, not on what the sandbox reads: the agent still
// uses the secrets of a hidden Secrets section, and a read route answers as it always did.
export const OrgSectionModeSchema = z.enum(["open", "locked", "hidden"]);
export type OrgSectionMode = z.infer<typeof OrgSectionModeSchema>;

// What an organisation admin edits. A section left out is open, so a policy written before a section existed opens it
// rather than guessing.
//
// `preset` PINS settings rather than locking a page: each named group of the public-office preset (compliance.ts
// PRESET_GROUPS; which settings a group holds is the daemon's compliance/preset.ts) is applied to what the sandbox READS,
// whatever its files say, and a change that would undo it is refused. Strings on the wire, not the enum: a group a newer
// platform names and this daemon does not know is skipped and reported (`unenforced`), never a reason to refuse the
// whole policy, which would stop every later edition reaching an older daemon. The platform validates the names an
// admin saves.
//
// `membersOnly` makes the organisation's member list the outer fence of every bound sandbox's roster: a person the
// organisation removes is taken off each sandbox's roster by its daemon at the next fetch, and a grant to someone who
// is not a member is refused. The sandbox's owner is not on a roster, so this never reaches them.
//
// Both are optional rather than defaulted, so every policy written before them (a stored row, a held file, a literal)
// still reads as the same type: absent is no pin and an open roster.
export const OrgPolicyRulesSchema = z.object({
    sections: z
        .partialRecord(OrgSectionSchema, OrgSectionModeSchema)
        .default({})
        .describe("How each section is held. A section left out is open."),
    preset: z
        .array(z.string().min(1).max(40))
        .max(40)
        .optional()
        .describe(`Public-office preset groups every bound sandbox is held to (${PRESET_GROUPS.join(", ")}). Unknown names are skipped.`),
    membersOnly: z
        .boolean()
        .optional()
        .describe("Only the organisation's members may be on a bound sandbox's roster; removing someone from the organisation removes them everywhere."),
});
export type OrgPolicyRules = z.infer<typeof OrgPolicyRulesSchema>;

// The rules as one sandbox receives them: whose they are and which edition. `version` only grows on the platform; the
// daemon reports the edition it holds back, which is how the organisation's console tells applied from pending.
// `people` is computed by the platform, never edited: the organisation's members, each as the sha256 of
// orgPersonPreimage, sent only while `membersOnly` is on, so a daemon can test an address without being handed the
// staff list in clear. A policy with `membersOnly` and no `people` fences nothing: no list is not an empty list.
export const OrgPolicySchema = OrgPolicyRulesSchema.extend({
    orgId: z.string().min(1).max(64),
    orgName: z.string().min(1).max(120),
    version: z.number().int().min(1),
    people: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).max(10_000).optional(),
});
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

// What the daemon answers the editor about it (GET /org/policy): unbound, or bound with the policy it enforces and
// when it last heard from the platform about it. `provisional` is a held file that could not be read: every section is
// held read-only until the platform answers, since a bound sandbox must not open up because its record broke.
// `unenforced` names preset groups the policy pins that this daemon does not know.
export const OrgPolicyStateSchema = z.discriminatedUnion("bound", [
    z.object({ bound: z.literal(false) }),
    z.object({
        bound: z.literal(true),
        policy: OrgPolicySchema,
        receivedAt: z.string().describe("When this edition arrived (ISO)."),
        provisional: z.boolean().optional(),
        unenforced: z.array(z.string()).optional(),
    }),
]);
export type OrgPolicyState = z.infer<typeof OrgPolicyStateSchema>;

// How a policy holds one section; anything it does not name is open.
export const orgSectionMode = (policy: Pick<OrgPolicy, "sections"> | undefined, section: OrgSection): OrgSectionMode =>
    policy?.sections[section] ?? "open";

// The preset groups a policy pins that this build knows, in the contract's order; none for a personal sandbox. A policy
// stored before pins existed has no `preset` at all.
export const orgPinnedGroups = (policy: Partial<Pick<OrgPolicy, "preset">> | undefined): PresetGroup[] =>
    PRESET_GROUPS.filter((group) => policy?.preset?.includes(group) === true);

// The names a policy pins that this build does not know.
export const orgUnknownPins = (policy: Partial<Pick<OrgPolicy, "preset">> | undefined): string[] =>
    (policy?.preset ?? []).filter((name) => !PresetGroupSchema.safeParse(name).success);

// What both sides hash (sha256, hex) to name one member of one organisation in `people`: salted with the organisation's
// id, so the same address in two organisations does not read as the same digest.
export const orgPersonPreimage = (orgId: string, email: string): string => `intentic-org-person:${orgId}:${email.trim().toLowerCase()}`;
