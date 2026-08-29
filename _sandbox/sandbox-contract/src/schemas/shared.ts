import { z } from "zod";
// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({
    ok: z
        .literal(true)
        .describe("Always true. A route that answers this either did the thing or refused with a status; there is no third outcome to report."),
});
// The trust tiers of everyone who can open this sandbox, ordered. `owner` is the one bound identity
// (auth/auth.ts); the other three are granted per email on the daemon's /members list. viewer watches,
// collaborator drives agents (outward actions become requests), maintainer has the owner's operating authority
// while remaining revokable. Ownership itself is not a grant and controls the access roster.
export const MemberRoleSchema = z.enum(["viewer", "collaborator", "maintainer", "owner"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
// The roles an invite can grant, everything but `owner`, which is bound at first sign-in, never granted.
export const GrantedRoleSchema = z.enum(["viewer", "collaborator", "maintainer"]);
export type GrantedRole = z.infer<typeof GrantedRoleSchema>;
// Shared by every surface that gates on a role (daemon route floors, web affordances) so the order lives in
// exactly one place.
const MEMBER_ROLE_RANK: Record<MemberRole, number> = { viewer: 0, collaborator: 1, maintainer: 2, owner: 3 };
export const roleAtLeast = (role: MemberRole, floor: MemberRole): boolean => MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[floor];
// Which repo a git route targets: "root" (the /work workspace repo) or a repo id, the repo's root-relative
// dir, which may be nested ("clients/foo"; URL-encoded in the path param). Kept as a bare string on the wire
// (not an enum) so an unknown repo is a handler-thrown NOT_FOUND, matching the daemon's prior 404, rather
// than an input-validation rejection.
export const RepoParamSchema = z.object({
    repo: z
        .string()
        .describe(
            'Which repository. "root" is the workspace itself; anything else is a repository\'s folder relative to the workspace root, URL-encoded.',
        ),
});
