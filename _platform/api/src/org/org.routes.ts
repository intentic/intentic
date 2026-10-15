import { apiContract, type OrgDetail, type OrgRole, OrgRoleSchema, type OrgSandbox } from "@intentic/api-contract";
import type { Prisma } from "@intentic/prisma";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin, requireOwnedSandbox, requireUser } from "../guards.js";
import { rulesOf } from "./org-policy.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE ORGANISATION CONSOLE'S ROUTES (docs/architecture/organisations.md). Membership is by address, lowercased, the
 * way a sandbox's roster is; who may do what is the caller's OrgMember row, read fresh on every call. Every mutation
 * answers with the organisation as its console draws it, so two admins' tabs converge on the next answer. */

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

const adminOf = async (context: OrpcContext, orgId: string) => {
    const membership = await membershipIn(context, orgId);
    if (membership.role !== `admin`) {
        throw new ORPCError(`FORBIDDEN`, { message: `only an admin of this organisation can do that` });
    }
    return membership;
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
            select: { id: true, name: true, lastSeenAt: true, orgPolicyApplied: true, owner: { select: { email: true } } },
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
            return row;
        }),
    };
};

// Re-reads the row after a write, so the answer is what the database now holds rather than what the write meant.
const freshDetail = async (context: OrpcContext, orgId: string) => {
    const { org, role } = await membershipIn(context, orgId);
    return detailOf(context, org, role);
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
        await adminOf(context, input.orgId);
        const written = await context.prisma.organisation.updateMany({
            where: { id: input.orgId, policyVersion: input.expectedVersion },
            data: { policy: input.rules, policyVersion: { increment: 1 } },
        });
        if (written.count === 0) {
            throw new ORPCError(`CONFLICT`, { message: `the policy changed since you opened it; reload and try again` });
        }
        return freshDetail(context, input.orgId);
    }),
    addMember: os.org.addMember.handler(async ({ context, input }) => {
        await adminOf(context, input.orgId);
        const email = input.email.toLowerCase();
        await context.prisma.orgMember.upsert({
            where: { orgId_email: { orgId: input.orgId, email } },
            create: { orgId: input.orgId, email, role: input.role },
            update: { role: input.role },
        });
        return freshDetail(context, input.orgId);
    }),
    // The last admin cannot be removed, or demoted by re-adding as a member: an organisation nobody can administer
    // holds its sandboxes to a policy nobody can change.
    removeMember: os.org.removeMember.handler(async ({ context, input }) => {
        await adminOf(context, input.orgId);
        const email = input.email.toLowerCase();
        const admins = await context.prisma.orgMember.findMany({ where: { orgId: input.orgId, role: `admin` }, select: { email: true } });
        if (admins.length === 1 && admins[0]?.email === email) {
            throw new ORPCError(`CONFLICT`, { message: `an organisation needs at least one admin; add another before removing this one` });
        }
        await context.prisma.orgMember.deleteMany({ where: { orgId: input.orgId, email } });
        return freshDetail(context, input.orgId);
    }),
    bindSandbox: os.org.bindSandbox.handler(async ({ context, input }) => {
        await adminOf(context, input.orgId);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        if (sandbox.orgId !== null && sandbox.orgId !== input.orgId) {
            throw new ORPCError(`CONFLICT`, { message: `this sandbox already belongs to another organisation` });
        }
        await context.prisma.sandbox.update({ where: { id: sandbox.id }, data: { orgId: input.orgId, orgPolicyApplied: null } });
        return freshDetail(context, input.orgId);
    }),
    unbindSandbox: os.org.unbindSandbox.handler(async ({ context, input }) => {
        await adminOf(context, input.orgId);
        const unbound = await context.prisma.sandbox.updateMany({
            where: { id: input.sandboxId, orgId: input.orgId },
            data: { orgId: null, orgPolicyApplied: null },
        });
        if (unbound.count === 0) {
            throw new ORPCError(`NOT_FOUND`, { message: `that sandbox is not in this organisation` });
        }
        return freshDetail(context, input.orgId);
    }),
};
