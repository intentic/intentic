// Named imports rather than the `z` namespace: this module is bundled into the browser extension, where the
// namespace keeps zod's 60 locales (~250 kB) that esbuild can otherwise drop. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { enum as zEnum, literal, object, string } from "zod";
import type * as z from "zod";
// Success ack for routes that only report completion (push, disconnect, self-host register). A paused turn or missing
// repo/path throws an ORPCError instead.
export const OkSchema = object({
    ok: literal(true)
        .describe("Always true. A route that answers this either did the thing or refused with a status; there is no third outcome to report."),
});
// Trust tiers, ordered low to high: guest talks to the persona cards it was handed and sees nothing else, viewer
// watches, collaborator's outward actions become requests, writer changes files inside the areas it holds and ships
// none of them, maintainer holds the owner's authority but is revocable, owner is the one bound identity and not a
// grant.
export const MemberRoleSchema = zEnum(["guest", "viewer", "collaborator", "writer", "maintainer", "owner"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
// Roles an invite can grant: everything but owner, which binds at first sign-in and is never granted.
export const GrantedRoleSchema = zEnum(["guest", "viewer", "collaborator", "writer", "maintainer"]);
export type GrantedRole = z.infer<typeof GrantedRoleSchema>;
// Single source for role order; every surface that gates on a role reads this ranking. A guest is below every
// floor: its routes are an allowlist of its own (protocol/member-reach.ts guestReach), never a floor it can clear.
const MEMBER_ROLE_RANK: Record<MemberRole, number> = { guest: 0, viewer: 1, collaborator: 2, writer: 3, maintainer: 4, owner: 5 };
export const roleAtLeast = (role: MemberRole, floor: MemberRole): boolean => MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[floor];
// Rotating a door credential (event webhook, release gate, bug intake): the old value stops working immediately; the
// new one is shown once to be saved.
export const DoorTokenSchema = object({
    token: string().min(1).describe("The freshly minted credential. The previous one stopped working the moment this answered."),
});
export type DoorToken = z.infer<typeof DoorTokenSchema>;
// "root" is the workspace repo; otherwise a repo id, its root-relative dir, URL-encoded, may be nested. Kept as a
// string so an unknown repo is a handler NOT_FOUND, not a validation error.
export const RepoParamSchema = object({
    repo: string()
        .describe(
            'Which repository. "root" is the workspace itself; anything else is a repository\'s folder relative to the workspace root, URL-encoded.',
        ),
});
// A shared checkout's main line (the daemon's git/main-line-lock.ts), named on a repository's changes only when
// something moved it elsewhere.
export const MainBranchSchema = string()
    .optional()
    .describe(
        "The branch this shared checkout belongs on, given only when it stands somewhere else: agents' work waits rather than land on the wrong branch until it is back. Absent, the normal case, means it is on its main line.",
    );
// One branch of one workspace repository, for what looks at it or starts from it while the shared checkout stays on its
// main line: the Workspace's per-person view of it, an agent started from it. A remote-only branch is named by its
// short name; the daemon makes the local one at the remote's tip the first time it is needed.
export const BranchNameSchema = string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(200)
    .describe("The branch, by its short name: `feature/login`, not `refs/heads/feature/login` or `origin/feature/login`.");
export const RepoBranchSchema = object({
    repo: string()
        .min(1)
        .describe('Which repository. "root" is the workspace itself; anything else is a repository\'s folder relative to the workspace root.'),
    branch: BranchNameSchema,
});
export type RepoBranch = z.infer<typeof RepoBranchSchema>;
