import { OrgPolicyRulesSchema } from "@intentic/sandbox-contract/schemas/organisation";
import { PresetGroupSchema } from "@intentic/sandbox-contract/schemas/compliance";
import { oc } from "@orpc/contract";
import { z } from "zod";

/* ORGANISATIONS (docs/architecture/organisations.md): a set of people and the sandboxes they run, under one policy an
 * organisation admin writes. A personal sandbox belongs to none and none of this touches it. The platform keeps the
 * policy and its edition; each bound sandbox's daemon fetches it over its connect token (the ingress `orgPolicy`) and
 * is the copy that enforces it. */

// `admin` writes the policy, the roster and which sandboxes are bound; `member` is listed, which is what later phases
// provision sandbox access from. A string at rest, so a third role is a contract change, not a migration.
export const OrgRoleSchema = z.enum(["admin", "member"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

export const OrgSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    // The caller's own role in it.
    role: OrgRoleSchema,
    sandboxCount: z.number().int(),
});
export type OrgSummary = z.infer<typeof OrgSummarySchema>;

export const OrgMemberSchema = z.object({
    email: z.string(),
    role: OrgRoleSchema,
    addedAt: z.string(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;

export const OrgSandboxSchema = z.object({
    id: z.string(),
    name: z.string(),
    ownerEmail: z.string(),
    // When its daemon last announced; absent for one that never has.
    lastSeenAt: z.string().optional(),
    // The policy edition its daemon last said it holds; behind the organisation's own edition means not yet applied.
    policyApplied: z.number().int().optional(),
    // When its daemon last came back holding less of the policy than it had reported (its held copy deleted, broken or
    // restored from an older one) and was sent it again; absent for one that never has.
    policyResetAt: z.string().optional(),
});
export type OrgSandbox = z.infer<typeof OrgSandboxSchema>;

// One organisation as its console reads it. `members` and `sandboxes` are an admin's to see; a member is shown the
// policy their sandboxes are held to and nothing about anyone else.
export const OrgDetailSchema = z.object({
    id: z.string(),
    name: z.string(),
    role: OrgRoleSchema,
    policy: OrgPolicyRulesSchema,
    policyVersion: z.number().int().min(1),
    members: z.array(OrgMemberSchema).optional(),
    sandboxes: z.array(OrgSandboxSchema).optional(),
});
export type OrgDetail = z.infer<typeof OrgDetailSchema>;

export const OrgListSchema = z.object({
    orgs: z.array(OrgSummarySchema),
    // Whether this platform lets the caller start a new organisation (config `orgs.creation`).
    canCreate: z.boolean(),
});
export type OrgList = z.infer<typeof OrgListSchema>;

const orgIdInput = z.object({ orgId: z.string().min(1) });
const OrgNameSchema = z.string().trim().min(2).max(120);

export const orgContract = {
    list: oc.route({ method: "GET", path: "/org" }).output(OrgListSchema),
    create: oc.route({ method: "POST", path: "/org/create" }).input(z.object({ name: OrgNameSchema })).output(OrgDetailSchema),
    get: oc.route({ method: "POST", path: "/org/get" }).input(orgIdInput).output(OrgDetailSchema),
    // A new edition of the rules. `expectedVersion` is the edition the admin edited, so two admins saving at once
    // cannot silently undo each other: the second is answered CONFLICT and reloads.
    // The pinned preset groups are checked against this build's here, where an admin saves them; the policy as a daemon
    // reads it takes any name, so a group a newer platform adds never stops a policy reaching an older daemon.
    setPolicy: oc
        .route({ method: "POST", path: "/org/policy" })
        .input(
            orgIdInput.extend({
                rules: OrgPolicyRulesSchema.extend({ preset: z.array(PresetGroupSchema).max(20).optional() }),
                expectedVersion: z.number().int().min(1),
            }),
        )
        .output(OrgDetailSchema),
    addMember: oc
        .route({ method: "POST", path: "/org/member/add" })
        .input(orgIdInput.extend({ email: z.email(), role: OrgRoleSchema }))
        .output(OrgDetailSchema),
    removeMember: oc
        .route({ method: "POST", path: "/org/member/remove" })
        .input(orgIdInput.extend({ email: z.string().min(3) }))
        .output(OrgDetailSchema),
    // Puts a sandbox under the organisation's policy. Its owner must be an admin of the organisation and the one
    // asking: binding constrains the owner, so it is never done to a sandbox by somebody else.
    bindSandbox: oc
        .route({ method: "POST", path: "/org/sandbox/bind" })
        .input(orgIdInput.extend({ sandboxId: z.string().min(1) }))
        .output(OrgDetailSchema),
    // Back to personal: the daemon drops the policy at its next fetch. An admin's to do, since an owner who could
    // unbind alone would make every lock optional.
    unbindSandbox: oc
        .route({ method: "POST", path: "/org/sandbox/unbind" })
        .input(orgIdInput.extend({ sandboxId: z.string().min(1) }))
        .output(OrgDetailSchema),
};
