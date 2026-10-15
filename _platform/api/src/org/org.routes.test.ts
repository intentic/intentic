import type { PrismaClient } from "@intentic/prisma";
import { call } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { orgPolicyForToken, refuseWhenOrgHolds, rulesOf } from "./org-policy.js";
import { orgRoutes } from "./org.routes.js";

/* THE ORGANISATION CONSOLE'S ROUTES against an in-memory database: who may do what, editions that cannot undo each
 * other, and what a bound daemon is answered. */

interface Org {
    id: string;
    name: string;
    policy: unknown;
    policyVersion: number;
}
interface Member {
    orgId: string;
    email: string;
    role: string;
    createdAt: Date;
}
interface Box {
    id: string;
    name: string;
    ownerId: string;
    ownerEmail: string;
    tokenDigest: string;
    orgId: string | null;
    orgPolicyApplied: number | null;
    lastSeenAt: Date | null;
}

// SAFETY: a test double standing in for a type it implements only the part of that these routes call; a call outside
// that part fails the test loudly rather than passing.
const stand = <T>(double: object): T => double as T;

const world = () => {
    const orgs: Org[] = [];
    const members: Member[] = [];
    const boxes: Box[] = [
        { id: `sbx-1`, name: `Kancelaria`, ownerId: `user-1`, ownerEmail: `it@gmina.test`, tokenDigest: `digest-1`, orgId: null, orgPolicyApplied: null, lastSeenAt: null },
        { id: `sbx-2`, name: `Someone else's`, ownerId: `user-2`, ownerEmail: `other@x.test`, tokenDigest: `digest-2`, orgId: null, orgPolicyApplied: null, lastSeenAt: null },
    ];
    const orgView = (org: Org) => ({ id: org.id, name: org.name, policy: org.policy, policyVersion: org.policyVersion });
    const prisma = {
        organisation: {
            create: async ({ data }: { data: { name: string; members: { create: { email: string; role: string } } } }) => {
                const org = { id: `org-${orgs.length + 1}`, name: data.name, policy: {}, policyVersion: 1 };
                orgs.push(org);
                members.push({ orgId: org.id, ...data.members.create, createdAt: new Date() });
                return orgView(org);
            },
            findUnique: async ({ where }: { where: { id: string } }) => orgs.find((org) => org.id === where.id) ?? null,
            updateMany: async ({ where, data }: { where: { id: string; policyVersion: number }; data: { policy: unknown } }) => {
                const org = orgs.find((row) => row.id === where.id && row.policyVersion === where.policyVersion);
                if (org === undefined) {
                    return { count: 0 };
                }
                org.policy = data.policy;
                org.policyVersion += 1;
                return { count: 1 };
            },
        },
        orgMember: {
            findUnique: async ({ where }: { where: { orgId_email: { orgId: string; email: string } } }) => {
                const row = members.find((member) => member.orgId === where.orgId_email.orgId && member.email === where.orgId_email.email);
                const org = orgs.find((candidate) => candidate.id === row?.orgId);
                return row === undefined || org === undefined ? null : { role: row.role, org: orgView(org) };
            },
            findMany: async ({ where }: { where: { orgId?: string; email?: string; role?: string } }) =>
                members
                    .filter((member) => (where.orgId === undefined || member.orgId === where.orgId) && (where.email === undefined || member.email === where.email))
                    .filter((member) => where.role === undefined || member.role === where.role)
                    .map((member) => {
                        const org = orgs.find((candidate) => candidate.id === member.orgId);
                        const sandboxes = boxes.filter((box) => box.orgId === member.orgId).length;
                        return { ...member, org: { id: org?.id, name: org?.name, _count: { sandboxes } } };
                    }),
            upsert: async ({ where, create, update }: { where: { orgId_email: { orgId: string; email: string } }; create: Member; update: { role: string } }) => {
                const row = members.find((member) => member.orgId === where.orgId_email.orgId && member.email === where.orgId_email.email);
                if (row === undefined) {
                    members.push({ ...create, createdAt: new Date() });
                } else {
                    row.role = update.role;
                }
                return {};
            },
            deleteMany: async ({ where }: { where: { orgId: string; email: string } }) => {
                const index = members.findIndex((member) => member.orgId === where.orgId && member.email === where.email);
                if (index >= 0) {
                    members.splice(index, 1);
                }
                return { count: index >= 0 ? 1 : 0 };
            },
        },
        sandbox: {
            findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => boxes.find((box) => box.id === where.id && box.ownerId === where.ownerId) ?? null,
            findMany: async ({ where }: { where: { orgId: string } }) =>
                boxes.filter((box) => box.orgId === where.orgId).map((box) => ({ ...box, owner: { email: box.ownerEmail } })),
            findUnique: async ({ where }: { where: { tokenDigest: string } }) => {
                const box = boxes.find((row) => row.tokenDigest === where.tokenDigest);
                if (box === undefined) {
                    return null;
                }
                const org = orgs.find((row) => row.id === box.orgId);
                return { id: box.id, orgPolicyApplied: box.orgPolicyApplied, org: org === undefined ? null : orgView(org) };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Box> }) => Object.assign(boxes.find((box) => box.id === where.id) ?? {}, data),
            updateMany: async ({ where, data }: { where: { id: string; orgId: string }; data: Partial<Box> }) => {
                const box = boxes.find((row) => row.id === where.id && row.orgId === where.orgId);
                if (box !== undefined) {
                    Object.assign(box, data);
                }
                return { count: box === undefined ? 0 : 1 };
            },
        },
    };
    return { orgs, members, boxes, prisma: stand<PrismaClient>(prisma) };
};

const as = (prisma: PrismaClient, email: string, id = `user-1`, creation: `operators` | `anyone` = `anyone`): OrpcContext =>
    stand<OrpcContext>({
        prisma,
        user: { id, email, name: email, image: null, emailVerified: true },
        config: { orgs: { creation }, admin: { emails: ``, signIn: `google` } },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

const started = async () => {
    const state = world();
    const admin = as(state.prisma, `IT@Gmina.test`);
    const org = await call(orgRoutes.create, { name: `Urząd Gminy` }, { context: admin });
    return { ...state, admin, org };
};

describe(`organisations`, () => {
    it(`starts one with its creator as the only admin and every section open`, async () => {
        const { org, members } = await started();
        expect(org).toMatchObject({ name: `Urząd Gminy`, role: `admin`, policyVersion: 1, policy: { sections: {} } });
        expect(members).toEqual([expect.objectContaining({ email: `it@gmina.test`, role: `admin` })]);
    });

    it(`lets only operators start one where the deployment says so`, async () => {
        const { prisma } = world();
        const clerk = as(prisma, `clerk@gmina.test`, `user-9`, `operators`);
        await expect(call(orgRoutes.create, { name: `Nope` }, { context: clerk })).rejects.toMatchObject({ code: `FORBIDDEN` });
        expect((await call(orgRoutes.list, undefined, { context: clerk })).canCreate).toBe(false);
    });

    it(`raises the edition on every save and refuses a save over a stale one`, async () => {
        const { admin, org } = await started();
        const saved = await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: { secrets: `hidden` } }, expectedVersion: 1 }, { context: admin });
        expect(saved).toMatchObject({ policyVersion: 2, policy: { sections: { secrets: `hidden` } } });
        await expect(
            call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {} }, expectedVersion: 1 }, { context: admin }),
        ).rejects.toMatchObject({ code: `CONFLICT` });
    });

    it(`shows a member the policy and nobody's names, and refuses them every change`, async () => {
        const { prisma, admin, org } = await started();
        await call(orgRoutes.addMember, { orgId: org.id, email: `Clerk@Gmina.test`, role: `member` }, { context: admin });
        const clerk = as(prisma, `clerk@gmina.test`, `user-3`);
        const seen = await call(orgRoutes.get, { orgId: org.id }, { context: clerk });
        expect(seen.role).toBe(`member`);
        expect(seen.members).toBeUndefined();
        await expect(
            call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {} }, expectedVersion: 1 }, { context: clerk }),
        ).rejects.toMatchObject({ code: `FORBIDDEN` });
    });

    it(`answers a stranger as if the organisation did not exist`, async () => {
        const { prisma, org } = await started();
        await expect(call(orgRoutes.get, { orgId: org.id }, { context: as(prisma, `stranger@x.test`, `user-7`) })).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    it(`never removes the last admin`, async () => {
        const { admin, org } = await started();
        await expect(call(orgRoutes.removeMember, { orgId: org.id, email: `it@gmina.test` }, { context: admin })).rejects.toMatchObject({ code: `CONFLICT` });
    });

    it(`binds only a sandbox the admin owns, and unbinds it back to personal`, async () => {
        const { admin, org, boxes } = await started();
        await expect(call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-2` }, { context: admin })).rejects.toMatchObject({ code: `NOT_FOUND` });
        const bound = await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        expect(bound.sandboxes).toEqual([{ id: `sbx-1`, name: `Kancelaria`, ownerEmail: `it@gmina.test` }]);
        await call(orgRoutes.unbindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        expect(boxes[0]?.orgId).toBeNull();
    });
});

describe(`what a sandbox's daemon is answered`, () => {
    it(`null for a personal sandbox, and nothing for a token with no row`, async () => {
        const { prisma } = world();
        expect(await orgPolicyForToken(prisma, `digest-1`, undefined)).toEqual({ policy: null });
        expect(await orgPolicyForToken(prisma, `digest-unknown`, undefined)).toBeUndefined();
    });

    it(`the current edition once bound, recording which edition the daemon holds`, async () => {
        const { admin, org, boxes } = await started();
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: { agent: `locked` } }, expectedVersion: 1 }, { context: admin });
        const answer = await orgPolicyForToken(admin.prisma, `digest-1`, 1);
        expect(answer).toEqual({ policy: { orgId: org.id, orgName: `Urząd Gminy`, version: 2, sections: { agent: `locked` } } });
        expect(boxes[0]?.orgPolicyApplied).toBe(1);
        const detail = await call(orgRoutes.get, { orgId: org.id }, { context: admin });
        expect(detail.sandboxes?.[0]?.policyApplied).toBe(1);
    });
});

describe(`the stored rules`, () => {
    it(`read a mode this build does not know as locked, and drop a section it does not know`, () => {
        expect(rulesOf({ sections: { secrets: `sealed`, agent: `open`, telepathy: `hidden` } })).toEqual({ sections: { secrets: `locked`, agent: `open` } });
        expect(rulesOf(null)).toEqual({ sections: {} });
    });

    it(`keep the invite routes off a sandbox whose organisation holds Access, and personal ones untouched`, async () => {
        const { admin, org } = await started();
        await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: { access: `locked` } }, expectedVersion: 1 }, { context: admin });
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: org.id }, `access`)).rejects.toMatchObject({ code: `FORBIDDEN` });
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: org.id }, `secrets`)).resolves.toBeUndefined();
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: null }, `access`)).resolves.toBeUndefined();
    });
});
