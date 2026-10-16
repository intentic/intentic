import {
    ORG_SECTIONS,
    type OrgPolicy,
    type OrgPolicyRules,
    type OrgSection,
    type OrgSectionMode,
    OrgSectionModeSchema,
    orgPersonPreimage,
    orgSectionMode,
} from "@intentic/sandbox-contract/schemas/organisation";
import { PRESET_GROUPS, PresetGroupSchema } from "@intentic/sandbox-contract/schemas/compliance";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

/* AN ORGANISATION'S POLICY, as the platform keeps it and hands it to a bound sandbox (docs/architecture/organisations.md).
 * The platform is where it is written; the daemon is where it is enforced. Two places here enforce it too, because they
 * act on a sandbox without going through its daemon: the invite routes, which keep the platform's copy of a roster the
 * daemon's Access lock would otherwise only freeze on one side. */

// The rules as stored, read leniently section by section: a section this build does not know is dropped (no route of
// this build belongs to it), and a mode it does not know is read as `locked`, so a newer platform's stricter word is
// never read here as open. Pinned preset groups this build does not know are dropped (it cannot say what they pin), and
// `membersOnly` is on only when it says so. Both are left out while unset, so a policy that uses neither reads, and is
// sent to a daemon, exactly as one written before they existed.
const StoredRulesSchema = z
    .object({
        sections: z.record(z.string(), z.unknown()).catch({}),
        preset: z.array(z.unknown()).catch([]).optional(),
        membersOnly: z.unknown().optional(),
    })
    .catch({ sections: {} });
export const rulesOf = (stored: Prisma.JsonValue): OrgPolicyRules => {
    const { sections, preset, membersOnly } = StoredRulesSchema.parse(stored);
    const read: Partial<Record<OrgSection, OrgSectionMode>> = {};
    for (const section of ORG_SECTIONS) {
        const mode = sections[section];
        if (mode !== undefined && mode !== null) {
            read[section] = OrgSectionModeSchema.catch(`locked`).parse(mode);
        }
    }
    const rules: OrgPolicyRules = { sections: read };
    const pinned = PRESET_GROUPS.filter((group) => (preset ?? []).some((name) => PresetGroupSchema.safeParse(name).data === group));
    if (pinned.length > 0) {
        rules.preset = pinned;
    }
    if (membersOnly === true) {
        rules.membersOnly = true;
    }
    return rules;
};

// One organisation member as a bound daemon is handed them (sandbox-contract `people`): a salted digest, never the address.
export const orgPersonDigest = (orgId: string, email: string): string => sha256Hex(orgPersonPreimage(orgId, email));

// The policy as a bound daemon receives it. `members` is the organisation's member list, read only while the rules keep
// sandboxes to the organisation's people; it is sent as digests, sorted, so the same list is the same policy.
export const policyOf = (
    org: { readonly id: string; readonly name: string; readonly policy: Prisma.JsonValue; readonly policyVersion: number },
    members: readonly { readonly email: string }[] = [],
): OrgPolicy => {
    const policy: OrgPolicy = { orgId: org.id, orgName: org.name, version: org.policyVersion, ...rulesOf(org.policy) };
    if (policy.membersOnly === true) {
        policy.people = members.map((member) => orgPersonDigest(org.id, member.email)).toSorted();
    }
    return policy;
};

// Whether a bound daemon's report says its held copy was tampered with or lost: it asks holding none, or an older edition
// than it reported before, or one past any edition the platform ever issued. Every legitimate path to the first two (a
// bind, a move to another organisation) resets the record first, and the third has none, so what is left is a held file
// deleted, broken, restored from somewhere older or edited, which the console shows. An edit that keeps the edition
// number is not seen here; the answer this report gets replaces it all the same.
export const policyWasReset = (recorded: number | null, applied: number | undefined, issued: number): boolean =>
    (applied !== undefined && applied > issued) || (recorded !== null && (applied === undefined || applied < recorded));

// What a daemon's fetch is answered (the ingress `orgPolicy`), recording the edition it says it holds. `undefined` is a
// token with no sandbox row; `null` policy is a personal sandbox.
export const orgPolicyForToken = async (
    prisma: PrismaClient,
    tokenDigest: string,
    applied: number | undefined,
    now: Date = new Date(),
): Promise<{ readonly policy: OrgPolicy | null } | undefined> => {
    const sandbox = await prisma.sandbox.findUnique({
        where: { tokenDigest },
        select: {
            id: true,
            orgPolicyApplied: true,
            org: { select: { id: true, name: true, policy: true, policyVersion: true, members: { select: { email: true } } } },
        },
    });
    if (sandbox === null) {
        return undefined;
    }
    // An edition the platform never issued is not one the sandbox holds: recorded as none, so the report that follows the
    // re-sent policy reads as the sandbox catching up, not as a second reset.
    const held = sandbox.org === null || applied === undefined || applied > sandbox.org.policyVersion ? null : applied;
    const reset = sandbox.org !== null && policyWasReset(sandbox.orgPolicyApplied, applied, sandbox.org.policyVersion);
    // Written only when it moved (or a reset is to be recorded): this is asked every few minutes by every bound sandbox.
    if (held !== sandbox.orgPolicyApplied || reset) {
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: reset ? { orgPolicyApplied: held, orgPolicyResetAt: now } : { orgPolicyApplied: held } });
    }
    return { policy: sandbox.org === null ? null : policyOf(sandbox.org, sandbox.org.members) };
};

// The organisation's row lock, taken first by every admin change (org.routes.ts `asAdmin`): a bind takes the sandbox's
// row lock after it, never before, which is the one order every path that holds both keeps.
export const lockOrganisation = async (tx: Prisma.TransactionClient, orgId: string): Promise<void> => {
    await tx.$queryRaw`SELECT id FROM organisation WHERE id = ${orgId} FOR UPDATE`;
};

// Refuses a platform-side change to a section the sandbox's organisation holds. A personal sandbox passes untouched.
export const refuseWhenOrgHolds = async (prisma: PrismaClient, sandbox: { readonly orgId: string | null }, section: OrgSection): Promise<void> => {
    if (sandbox.orgId === null) {
        return;
    }
    const org = await prisma.organisation.findUnique({ where: { id: sandbox.orgId }, select: { name: true, policy: true } });
    if (org !== null && orgSectionMode(rulesOf(org.policy), section) !== `open`) {
        throw new ORPCError(`FORBIDDEN`, { message: `${org.name} manages who may use this sandbox; ask your organisation's admin.` });
    }
};
