import {
    ORG_SECTIONS,
    type OrgPolicy,
    type OrgPolicyRules,
    type OrgSection,
    type OrgSectionMode,
    OrgSectionModeSchema,
    orgSectionMode,
} from "@intentic/sandbox-contract";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

/* AN ORGANISATION'S POLICY, as the platform keeps it and hands it to a bound sandbox (docs/architecture/organisations.md).
 * The platform is where it is written; the daemon is where it is enforced. Two places here enforce it too, because they
 * act on a sandbox without going through its daemon: the invite routes, which keep the platform's copy of a roster the
 * daemon's Access lock would otherwise only freeze on one side. */

// The rules as stored, read leniently section by section: a section this build does not know is dropped (no route of
// this build belongs to it), and a mode it does not know is read as `locked`, so a newer platform's stricter word is
// never read here as open.
const StoredRulesSchema = z.object({ sections: z.record(z.string(), z.unknown()).catch({}) }).catch({ sections: {} });
export const rulesOf = (stored: Prisma.JsonValue): OrgPolicyRules => {
    const { sections } = StoredRulesSchema.parse(stored);
    const read: Partial<Record<OrgSection, OrgSectionMode>> = {};
    for (const section of ORG_SECTIONS) {
        const mode = sections[section];
        if (mode !== undefined && mode !== null) {
            read[section] = OrgSectionModeSchema.catch(`locked`).parse(mode);
        }
    }
    return { sections: read };
};

export const policyOf = (org: { readonly id: string; readonly name: string; readonly policy: Prisma.JsonValue; readonly policyVersion: number }): OrgPolicy => ({
    orgId: org.id,
    orgName: org.name,
    version: org.policyVersion,
    ...rulesOf(org.policy),
});

// What a daemon's fetch is answered (the ingress `orgPolicy`), recording the edition it says it holds. `undefined` is a
// token with no sandbox row; `null` policy is a personal sandbox.
export const orgPolicyForToken = async (
    prisma: PrismaClient,
    tokenDigest: string,
    applied: number | undefined,
): Promise<{ readonly policy: OrgPolicy | null } | undefined> => {
    const sandbox = await prisma.sandbox.findUnique({
        where: { tokenDigest },
        select: { id: true, orgPolicyApplied: true, org: { select: { id: true, name: true, policy: true, policyVersion: true } } },
    });
    if (sandbox === null) {
        return undefined;
    }
    const held = sandbox.org === null ? null : applied ?? null;
    // Written only when it moved: this is asked every few minutes by every bound sandbox.
    if (held !== sandbox.orgPolicyApplied) {
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { orgPolicyApplied: held } });
    }
    return { policy: sandbox.org === null ? null : policyOf(sandbox.org) };
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
