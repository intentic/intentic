// Named imports rather than the `z` namespace: this module is bundled into the browser extension, where the
// namespace keeps zod's 60 locales (~250 kB) that esbuild can otherwise drop. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { enum as zEnum, literal, looseObject, object, optional, preprocess, string, undefined as zUndefined } from "zod";
import type * as z from "zod";
// Success ack for routes that only report completion (push, disconnect, self-host register). A paused turn or missing
// repo/path throws an ORPCError instead.
export const OkSchema = object({
    ok: literal(true)
        .describe("Always true. A route that answers this either did the thing or refused with a status; there is no third outcome to report."),
});
// Trust tiers, ordered low to high: guest talks to the role cards it was handed and sees nothing else, viewer
// watches, collaborator's outward actions become requests, writer changes files inside the areas it holds and ships
// none of them, maintainer holds the owner's authority but is revocable, owner is the one bound identity and not a
// grant.
export const MemberTierSchema = zEnum(["guest", "viewer", "collaborator", "writer", "maintainer", "owner"]);
export type MemberTier = z.infer<typeof MemberTierSchema>;
// Tiers an invite can grant: everything but owner, which binds at first sign-in and is never granted. Called roles until
// 2026-11-18, when personas were renamed roles; the wire key a tier rides under moved from `role` to `tier`.
export const GrantedTierSchema = zEnum(["guest", "viewer", "collaborator", "writer", "maintainer"]);
export type GrantedTier = z.infer<typeof GrantedTierSchema>;
// Single source for tier order; every surface that gates on a tier reads this ranking. A guest is below every
// floor: its routes are an allowlist of its own (protocol/member-reach.ts guestReach), never a floor it can clear.
const MEMBER_TIER_RANK: Record<MemberTier, number> = { guest: 0, viewer: 1, collaborator: 2, writer: 3, maintainer: 4, owner: 5 };
export const tierAtLeast = (tier: MemberTier, floor: MemberTier): boolean => MEMBER_TIER_RANK[tier] >= MEMBER_TIER_RANK[floor];
// A tier rode under `role` on the wire until 2026-11-18. What a sender from before writes (an older daemon's roster,
// presence or profile holders; an older editor's grant) is read as `tier`; a value that already says `tier` is read
// as it is.
const LegacyTierSchema = looseObject({ role: string(), tier: optional(zUndefined()) });
export const withLegacyTier = <S extends z.ZodType>(schema: S) =>
    preprocess((raw) => {
        const legacy = LegacyTierSchema.safeParse(raw);
        if (!legacy.success) {
            return raw;
        }
        const { role, tier: _absent, ...rest } = legacy.data;
        return { ...rest, tier: role };
    }, schema);
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
