import { z } from "zod";

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
export const OrgPolicyRulesSchema = z.object({
    sections: z
        .partialRecord(OrgSectionSchema, OrgSectionModeSchema)
        .default({})
        .describe("How each section is held. A section left out is open."),
});
export type OrgPolicyRules = z.infer<typeof OrgPolicyRulesSchema>;

// The rules as one sandbox receives them: whose they are and which edition. `version` only grows; a daemon keeps the
// newest it was handed and reports it back, which is how the organisation's console tells applied from pending.
export const OrgPolicySchema = OrgPolicyRulesSchema.extend({
    orgId: z.string().min(1).max(64),
    orgName: z.string().min(1).max(120),
    version: z.number().int().min(1),
});
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

// What the daemon answers the editor about it (GET /org/policy): unbound, or bound with the policy it enforces and
// when it last heard from the platform about it.
export const OrgPolicyStateSchema = z.discriminatedUnion("bound", [
    z.object({ bound: z.literal(false) }),
    z.object({
        bound: z.literal(true),
        policy: OrgPolicySchema,
        receivedAt: z.string().describe("When this edition arrived (ISO)."),
    }),
]);
export type OrgPolicyState = z.infer<typeof OrgPolicyStateSchema>;

// How a policy holds one section; anything it does not name is open.
export const orgSectionMode = (policy: Pick<OrgPolicy, "sections"> | undefined, section: OrgSection): OrgSectionMode =>
    policy?.sections[section] ?? "open";
