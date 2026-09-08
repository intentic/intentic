import { z } from "zod";
// Success ack for routes that only report completion (push, disconnect, self-host register). A paused turn or missing
// repo/path throws an ORPCError instead.
export const OkSchema = z.object({
    ok: z
        .literal(true)
        .describe("Always true. A route that answers this either did the thing or refused with a status; there is no third outcome to report."),
});
// Trust tiers, ordered low to high: viewer watches, collaborator's outward actions become requests, maintainer holds
// the owner's authority but is revocable, owner is the one bound identity and not a grant.
export const MemberRoleSchema = z.enum(["viewer", "collaborator", "maintainer", "owner"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
// Roles an invite can grant: everything but owner, which binds at first sign-in and is never granted.
export const GrantedRoleSchema = z.enum(["viewer", "collaborator", "maintainer"]);
export type GrantedRole = z.infer<typeof GrantedRoleSchema>;
// Single source for role order; every surface that gates on a role reads this ranking.
const MEMBER_ROLE_RANK: Record<MemberRole, number> = { viewer: 0, collaborator: 1, maintainer: 2, owner: 3 };
export const roleAtLeast = (role: MemberRole, floor: MemberRole): boolean => MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[floor];
// Rotating a door credential (event webhook, release gate, bug intake): the old value stops working immediately; the
// new one is shown once to be saved.
export const DoorTokenSchema = z.object({
    token: z.string().min(1).describe("The freshly minted credential. The previous one stopped working the moment this answered."),
});
export type DoorToken = z.infer<typeof DoorTokenSchema>;
// "root" is the workspace repo; otherwise a repo id, its root-relative dir, URL-encoded, may be nested. Kept as a
// string so an unknown repo is a handler NOT_FOUND, not a validation error.
export const RepoParamSchema = z.object({
    repo: z
        .string()
        .describe(
            'Which repository. "root" is the workspace itself; anything else is a repository\'s folder relative to the workspace root, URL-encoded.',
        ),
});
