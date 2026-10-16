import { apiContract, type OrgDetail, type OrgRole, OrgRoleSchema, type OrgSandbox } from "@intentic/api-contract";
import type { Prisma } from "@intentic/prisma";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin, requireUser } from "../guards.js";
import { lockHostedSandbox } from "../sandbox/hosted/hosted-cleanup.js";
import { lockOrganisation, rulesOf } from "./org-policy.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE ORGANISATION CONSOLE'S ROUTES (docs/architecture/organisations.md). Membership is by address, lowercased, the
 * way a sandbox's roster is; who may do what is the caller's OrgMember row, read fresh on every call. Every mutation
 * answers with the organisation as its console draws it, so two admins' tabs converge on the next answer.
 *
 * Every change an admin makes runs in one transaction under the organisation's row lock (`asAdmin`), with the caller's
 * own role read inside it. Two admins acting at once are taken one after the other, so neither acts on a role the other
 * just took away, and a guard that counts admins counts what the other's commit left: without it two admins removing
 * or demoting each other at the same moment both passed the last-admin check and left none. A bind also takes the
 * sandbox's row lock, the one a delete and an account erasure take (sandbox-trash.ts, account-erase.ts), always after
 * the organisation's, so the three cannot interleave and the order cannot deadlock. */

// Who may start one: this deployment's operators, or anyone signed in where the deployment says so.
const mayCreate = async (context: OrpcContext): Promise<boolean> => {
    if (context.config.orgs.creation === `anyone`) {
        return requireUser(context) !== null;
    }
    // allow(silent-catch): requireAdmin's refusal is the answer itself here, "not an operator", not a fault.
    return requireAdmin(context).then(
        () => true,
        () => false,
    );
};

type OrgRow = { readonly id: string; readonly name: string; readonly policy: Prisma.JsonValue; readonly policyVersion: number };

// The caller's row in an organisation, and the organisation. One that does not exist and one the caller is not in
// answer alike, so an id is no oracle for which organisations exist.
const membershipIn = async (context: OrpcContext, orgId: string): Promise<{ readonly org: OrgRow; readonly role: OrgRole; readonly email: string }> => {
    const user = requireUser(context);
    const email = user.email.toLowerCase();
    const row = await context.prisma.orgMember.findUnique({
        where: { orgId_email: { orgId, email } },
        select: { role: true, org: { select: { id: true, name: true, policy: true, policyVersion: true } } },
    });
    if (row === null) {
        throw new ORPCError(`NOT_FOUND`, { message: `organisation not found` });
    }
    // A role this build does not know is the least one there is.
    return { org: row.org, role: OrgRoleSchema.catch(`member`).parse(row.role), email };
};

// An admin's change: one transaction, the organisation's row locked first, the caller's role read under the lock. A
// caller removed or demoted by a change that committed first is answered as such, never let through on a stale read.
const asAdmin = async <T>(context: OrpcContext, orgId: string, change: (tx: Prisma.TransactionClient, org: OrgRow) => Promise<T>): Promise<T> => {
    const email = requireUser(context).email.toLowerCase();
    return context.prisma.$transaction(async (tx) => {
        await lockOrganisation(tx, orgId);
        const row = await tx.orgMember.findUnique({
            where: { orgId_email: { orgId, email } },
            select: { role: true, org: { select: { id: true, name: true, policy: true, policyVersion: true } } },
        });
        if (row === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `organisation not found` });
        }
        if (OrgRoleSchema.catch(`member`).parse(row.role) !== `admin`) {
            throw new ORPCError(`FORBIDDEN`, { message: `only an admin of this organisation can do that` });
        }
        return change(tx, row.org);
    });
};

const detailOf = async (context: OrpcContext, org: OrgRow, role: OrgRole): Promise<OrgDetail> => {
    const base = { id: org.id, name: org.name, role, policy: rulesOf(org.policy), policyVersion: org.policyVersion };
    if (role !== `admin`) {
        return base;
    }
    const [members, sandboxes] = await Promise.all([
        context.prisma.orgMember.findMany({ where: { orgId: org.id }, orderBy: { createdAt: `asc` }, select: { email: true, role: true, createdAt: true } }),
        context.prisma.sandbox.findMany({
            where: { orgId: org.id },
            orderBy: { createdAt: `asc` },
            select: { id: true, name: true, lastSeenAt: true, orgPolicyApplied: true, orgPolicyResetAt: true, owner: { select: { email: true } } },
        }),
    ]);
    return {
        ...base,
        members: members.map((member) => ({
            email: member.email,
            role: OrgRoleSchema.catch(`member`).parse(member.role),
            addedAt: member.createdAt.toISOString(),
        })),
        sandboxes: sandboxes.map((sandbox) => {
            const row: OrgSandbox = { id: sandbox.id, name: sandbox.name, ownerEmail: sandbox.owner.email };
            if (sandbox.lastSeenAt !== null) {
                row.lastSeenAt = sandbox.lastSeenAt.toISOString();
            }
            if (sandbox.orgPolicyApplied !== null) {
                row.policyApplied = sandbox.orgPolicyApplied;
            }
            if (sandbox.orgPolicyResetAt !== null) {
                row.policyResetAt = sandbox.orgPolicyResetAt.toISOString();
            }
            return row;
        }),
    };
};

// Re-reads the row after a write, so the answer is what the database now holds rather than what the write meant.
const freshDetail = async (context: OrpcContext, orgId: string) => {
    const { org, role } = await membershipIn(context, orgId);
    return detailOf(context, org, role);
};

// A member list that changed is a new edition of the policy wherever the policy keeps sandboxes to the organisation's
// people: what each bound daemon is sent changed (org-policy.ts `people`), and the console's applied/pending is read off
// the edition, so an admin can see the change reach each sandbox.
const raiseIfMembersOnly = async (tx: Prisma.TransactionClient, org: OrgRow): Promise<void> => {
    if (rulesOf(org.policy).membersOnly === true) {
        await tx.organisation.update({ where: { id: org.id }, data: { policyVersion: { increment: 1 } } });
    }
};

// Whether removing or demoting `email` would leave the organisation with no admin: one nobody can administer holds its
// sandboxes to a policy nobody can change, and no sandbox of it can ever be released. Read under the organisation's
// lock (`asAdmin`), so it counts what every earlier change committed.
const lastAdmin = async (tx: Prisma.TransactionClient, orgId: string, email: string): Promise<boolean> => {
    const admins = await tx.orgMember.findMany({ where: { orgId, role: `admin` }, select: { email: true } });
    return admins.length === 1 && admins[0]?.email === email;
};

export const orgRoutes = {
    list: os.org.list.handler(async ({ context }) => {
        const user = requireUser(context);
        const rows = await context.prisma.orgMember.findMany({
            where: { email: user.email.toLowerCase() },
            orderBy: { createdAt: `asc` },
            select: { role: true, org: { select: { id: true, name: true, _count: { select: { sandboxes: true } } } } },
        });
        return {
            orgs: rows.map((row) => ({
                id: row.org.id,
                name: row.org.name,
                role: OrgRoleSchema.catch(`member`).parse(row.role),
                sandboxCount: row.org._count.sandboxes,
            })),
            canCreate: await mayCreate(context),
        };
    }),
    // The creator is its first admin; an organisation starts with every section open, the same as a personal sandbox.
    create: os.org.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        if (!(await mayCreate(context))) {
            throw new ORPCError(`FORBIDDEN`, { message: `on this platform, organisations are started by its operators` });
        }
        const org = await context.prisma.organisation.create({
            data: { name: input.name, members: { create: { email: user.email.toLowerCase(), role: `admin` } } },
            select: { id: true, name: true, policy: true, policyVersion: true },
        });
        return detailOf(context, org, `admin`);
    }),
    get: os.org.get.handler(async ({ context, input }) => {
        const { org, role } = await membershipIn(context, input.orgId);
        return detailOf(context, org, role);
    }),
    // Written only over the edition the admin edited; the version moves in the same statement, so a bound daemon's next
    // fetch sees the new edition and the console sees it pending until each daemon says it holds it.
    setPolicy: os.org.setPolicy.handler(async ({ context, input }) => {
        await asAdmin(context, input.orgId, async (tx) => {
            const written = await tx.organisation.updateMany({
                where: { id: input.orgId, policyVersion: input.expectedVersion },
                data: { policy: input.rules, policyVersion: { increment: 1 } },
            });
            if (written.count === 0) {
                throw new ORPCError(`CONFLICT`, { message: `the policy changed since you opened it; reload and try again` });
            }
        });
        return freshDetail(context, input.orgId);
    }),
    // Re-adding someone sets their role, which is also how an admin is demoted; never the last one.
    addMember: os.org.addMember.handler(async ({ context, input }) => {
        const email = input.email.toLowerCase();
        await asAdmin(context, input.orgId, async (tx, org) => {
            if (input.role !== `admin` && (await lastAdmin(tx, input.orgId, email))) {
                throw new ORPCError(`CONFLICT`, { message: `an organisation needs at least one admin; make someone else an admin before changing this one` });
            }
            const existing = await tx.orgMember.findUnique({ where: { orgId_email: { orgId: input.orgId, email } }, select: { role: true } });
            await tx.orgMember.upsert({
                where: { orgId_email: { orgId: input.orgId, email } },
                create: { orgId: input.orgId, email, role: input.role },
                update: { role: input.role },
            });
            if (existing === null) {
                await raiseIfMembersOnly(tx, org);
            }
        });
        return freshDetail(context, input.orgId);
    }),
    // A LEAVER: never the last admin. The platform's own grants to the organisation's sandboxes go with the person (their
    // listing and the identity assertions that need them, sandbox.routes.ts and identity-assertion.ts); the daemons'
    // rosters, the copies that are enforced, follow at their next fetch where the policy keeps sandboxes to the
    // organisation's people (`membersOnly`), and are each sandbox's own to change otherwise.
    removeMember: os.org.removeMember.handler(async ({ context, input }) => {
        const email = input.email.toLowerCase();
        const removed = await asAdmin(context, input.orgId, async (tx, org) => {
            if (await lastAdmin(tx, input.orgId, email)) {
                throw new ORPCError(`CONFLICT`, { message: `an organisation needs at least one admin; add another before removing this one` });
            }
            const gone = await tx.orgMember.deleteMany({ where: { orgId: input.orgId, email } });
            if (gone.count > 0) {
                await tx.sandboxMember.deleteMany({ where: { email, sandbox: { orgId: input.orgId } } });
                await raiseIfMembersOnly(tx, org);
            }
            return gone.count > 0;
        });
        if (removed) {
            context.logger.info({ orgId: input.orgId }, `org: a member was removed, with their grants to the organisation's sandboxes`);
        }
        return freshDetail(context, input.orgId);
    }),
    // Under the sandbox's row lock too, re-read there: a delete or an account erasure that committed first has taken the
    // row (answered as not found), and one waiting behind this bind finds the sandbox bound and refuses.
    bindSandbox: os.org.bindSandbox.handler(async ({ context, input }) => {
        const owner = requireUser(context);
        await asAdmin(context, input.orgId, async (tx) => {
            await lockHostedSandbox(tx, input.sandboxId);
            const sandbox = await tx.sandbox.findFirst({ where: { id: input.sandboxId, ownerId: owner.id }, select: { id: true, orgId: true } });
            if (sandbox === null) {
                throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
            }
            if (sandbox.orgId !== null && sandbox.orgId !== input.orgId) {
                throw new ORPCError(`CONFLICT`, { message: `this sandbox already belongs to another organisation` });
            }
            await tx.sandbox.update({ where: { id: sandbox.id }, data: { orgId: input.orgId, orgPolicyApplied: null } });
        });
        return freshDetail(context, input.orgId);
    }),
    unbindSandbox: os.org.unbindSandbox.handler(async ({ context, input }) => {
        await asAdmin(context, input.orgId, async (tx) => {
            const unbound = await tx.sandbox.updateMany({
                where: { id: input.sandboxId, orgId: input.orgId },
                data: { orgId: null, orgPolicyApplied: null },
            });
            if (unbound.count === 0) {
                throw new ORPCError(`NOT_FOUND`, { message: `that sandbox is not in this organisation` });
            }
        });
        return freshDetail(context, input.orgId);
    }),
};
