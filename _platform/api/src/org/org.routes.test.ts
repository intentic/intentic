import type { PrismaClient } from "@intentic/prisma";
import { call } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { orgPersonDigest, orgPolicyForToken, policyWasReset, refuseWhenOrgHolds, rulesOf } from "./org-policy.js";
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
    orgPolicyResetAt: Date | null;
    lastSeenAt: Date | null;
}
interface Grant {
    sandboxId: string;
    email: string;
}

// SAFETY: a test double standing in for a type it implements only the part of that these routes call; a call outside
// that part fails the test loudly rather than passing.
const stand = <T>(double: object): T => double as T;

const world = () => {
    const orgs: Org[] = [];
    const members: Member[] = [];
    const boxes: Box[] = [
        { id: `sbx-1`, name: `Kancelaria`, ownerId: `user-1`, ownerEmail: `it@gmina.test`, tokenDigest: `digest-1`, orgId: null, orgPolicyApplied: null, orgPolicyResetAt: null, lastSeenAt: null },
        { id: `sbx-2`, name: `Someone else's`, ownerId: `user-2`, ownerEmail: `other@x.test`, tokenDigest: `digest-2`, orgId: null, orgPolicyApplied: null, orgPolicyResetAt: null, lastSeenAt: null },
    ];
    // The platform's copy of who may use which sandbox (SandboxMember), as far as these routes touch it.
    const grants: Grant[] = [];
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
            update: async ({ where }: { where: { id: string }; data: { policyVersion: { increment: number } } }) => {
                const org = orgs.find((row) => row.id === where.id);
                if (org !== undefined) {
                    org.policyVersion += 1;
                }
                return org;
            },
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
                const people = members.filter((member) => member.orgId === org?.id).map((member) => ({ email: member.email }));
                return { id: box.id, orgPolicyApplied: box.orgPolicyApplied, org: org === undefined ? null : { ...orgView(org), members: people } };
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
        sandboxMember: {
            deleteMany: async ({ where }: { where: { email: string; sandbox: { orgId: string } } }) => {
                const doomed = grants.filter((grant) => grant.email === where.email && boxes.some((box) => box.id === grant.sandboxId && box.orgId === where.sandbox.orgId));
                for (const grant of doomed) {
                    grants.splice(grants.indexOf(grant), 1);
                }
                return { count: doomed.length };
            },
        },
    };
    // The row locks a transaction took, in order, as `<table>:<id>`: an in-memory double cannot block on one, so what is
    // checked here is which locks a change takes and in which order; e2e/org-concurrency.e2e.test.ts races them for real.
    const locks: string[] = [];
    const db = {
        ...prisma,
        $transaction: async <T>(work: (tx: typeof prisma & { $queryRaw: typeof lockRow }) => Promise<T>): Promise<T> => work({ ...prisma, $queryRaw: lockRow }),
    };
    const lockRow = async (sql: TemplateStringsArray, id: string): Promise<unknown[]> => {
        locks.push(`${/FROM (\w+)/u.exec(sql.join(``))?.[1] ?? `?`}:${id}`);
        return [];
    };
    return { orgs, members, boxes, grants, locks, prisma: stand<PrismaClient>(db) };
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

    it(`never demotes the last admin by adding them again as a member, and lets one go once another admin exists`, async () => {
        const { admin, org, members } = await started();
        await expect(call(orgRoutes.addMember, { orgId: org.id, email: `IT@gmina.test`, role: `member` }, { context: admin })).rejects.toMatchObject({
            code: `CONFLICT`,
        });
        expect(members).toEqual([expect.objectContaining({ email: `it@gmina.test`, role: `admin` })]);
        await call(orgRoutes.addMember, { orgId: org.id, email: `deputy@gmina.test`, role: `admin` }, { context: admin });
        const demoted = await call(orgRoutes.addMember, { orgId: org.id, email: `it@gmina.test`, role: `member` }, { context: admin });
        expect(demoted.role).toBe(`member`);
    });

    it(`takes a leaver's grants to the organisation's sandboxes with them, and leaves their other grants alone`, async () => {
        const { admin, org, grants, boxes } = await started();
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        await call(orgRoutes.addMember, { orgId: org.id, email: `leaver@gmina.test`, role: `member` }, { context: admin });
        grants.push({ sandboxId: `sbx-1`, email: `leaver@gmina.test` }, { sandboxId: `sbx-2`, email: `leaver@gmina.test` });
        expect(boxes[1]?.orgId).toBeNull();
        const after = await call(orgRoutes.removeMember, { orgId: org.id, email: `Leaver@gmina.test` }, { context: admin });
        expect(after.members?.map((member) => member.email)).toEqual([`it@gmina.test`]);
        expect(grants).toEqual([{ sandboxId: `sbx-2`, email: `leaver@gmina.test` }]);
    });

    it(`raises the edition when the member list changes, but only while the policy keeps sandboxes to members`, async () => {
        const { admin, org } = await started();
        const added = await call(orgRoutes.addMember, { orgId: org.id, email: `clerk@gmina.test`, role: `member` }, { context: admin });
        expect(added.policyVersion).toBe(1);
        const fenced = await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {}, membersOnly: true }, expectedVersion: 1 }, { context: admin });
        expect(fenced.policyVersion).toBe(2);
        expect((await call(orgRoutes.addMember, { orgId: org.id, email: `new@gmina.test`, role: `member` }, { context: admin })).policyVersion).toBe(3);
        // A role change is not a new person: what a daemon is sent does not move.
        expect((await call(orgRoutes.addMember, { orgId: org.id, email: `new@gmina.test`, role: `admin` }, { context: admin })).policyVersion).toBe(3);
        expect((await call(orgRoutes.removeMember, { orgId: org.id, email: `clerk@gmina.test` }, { context: admin })).policyVersion).toBe(4);
    });

    it(`saves pinned preset groups this build knows and refuses a name it does not`, async () => {
        const { admin, org } = await started();
        const saved = await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {}, preset: [`privacy`, `actions`] }, expectedVersion: 1 }, { context: admin });
        expect(saved.policy).toEqual({ sections: {}, preset: [`privacy`, `actions`] });
        // SAFETY: deliberately not the input type, since what the route's own validation does with a stray name is the test.
        const stray = { sections: {}, preset: [`telepathy`] } as never;
        await expect(call(orgRoutes.setPolicy, { orgId: org.id, rules: stray, expectedVersion: 2 }, { context: admin })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
    });

    it(`takes the organisation's row lock for every admin change, and a bind takes the sandbox's after it`, async () => {
        const { admin, org, locks } = await started();
        await call(orgRoutes.addMember, { orgId: org.id, email: `clerk@gmina.test`, role: `member` }, { context: admin });
        await call(orgRoutes.removeMember, { orgId: org.id, email: `clerk@gmina.test` }, { context: admin });
        await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {} }, expectedVersion: 1 }, { context: admin });
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        await call(orgRoutes.unbindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        const organisation = `organisation:${org.id}`;
        expect(locks).toEqual([organisation, organisation, organisation, organisation, `sandbox:sbx-1`, organisation]);
    });

    it(`re-reads the caller's role under the lock, so a removed admin's change is refused rather than let through`, async () => {
        const { prisma, admin, org, members } = await started();
        await call(orgRoutes.addMember, { orgId: org.id, email: `deputy@gmina.test`, role: `admin` }, { context: admin });
        const deputy = as(prisma, `deputy@gmina.test`, `user-4`);
        // What a concurrent removal that committed first leaves: the deputy's row gone before their own change runs.
        members.splice(members.findIndex((member) => member.email === `deputy@gmina.test`), 1);
        await expect(call(orgRoutes.removeMember, { orgId: org.id, email: `it@gmina.test` }, { context: deputy })).rejects.toMatchObject({ code: `NOT_FOUND` });
        expect(members.map((member) => member.email)).toEqual([`it@gmina.test`]);
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

    it(`the organisation's people as salted digests, sorted, while the policy keeps sandboxes to members`, async () => {
        const { admin, org } = await started();
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        await call(orgRoutes.addMember, { orgId: org.id, email: `clerk@gmina.test`, role: `member` }, { context: admin });
        expect((await orgPolicyForToken(admin.prisma, `digest-1`, undefined))?.policy).not.toHaveProperty(`people`);
        await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: {}, membersOnly: true }, expectedVersion: 1 }, { context: admin });
        const answer = await orgPolicyForToken(admin.prisma, `digest-1`, 1);
        expect(answer?.policy).toMatchObject({ membersOnly: true, version: 2 });
        expect(answer?.policy?.people).toEqual([orgPersonDigest(org.id, `it@gmina.test`), orgPersonDigest(org.id, `clerk@gmina.test`)].toSorted());
        expect(JSON.stringify(answer)).not.toContain(`clerk@gmina.test`);
    });

    it(`records when a bound daemon comes back holding less than it had, and shows it to the admin`, async () => {
        const { admin, org, boxes } = await started();
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        await orgPolicyForToken(admin.prisma, `digest-1`, undefined);
        expect(boxes[0]?.orgPolicyResetAt).toBeNull();
        await orgPolicyForToken(admin.prisma, `digest-1`, 1);
        expect(boxes[0]?.orgPolicyResetAt).toBeNull();
        const at = new Date(`2026-10-15T12:00:00Z`);
        await orgPolicyForToken(admin.prisma, `digest-1`, undefined, at);
        expect(boxes[0]).toMatchObject({ orgPolicyApplied: null, orgPolicyResetAt: at });
        const detail = await call(orgRoutes.get, { orgId: org.id }, { context: admin });
        expect(detail.sandboxes?.[0]?.policyResetAt).toBe(`2026-10-15T12:00:00.000Z`);
    });

    it(`counts a lost, older or never-issued edition as a reset, and a first or newer report as none`, () => {
        expect(policyWasReset(null, undefined, 4)).toBe(false);
        expect(policyWasReset(null, 3, 4)).toBe(false);
        expect(policyWasReset(3, 3, 4)).toBe(false);
        expect(policyWasReset(3, 4, 4)).toBe(false);
        expect(policyWasReset(3, 2, 4)).toBe(true);
        expect(policyWasReset(3, undefined, 4)).toBe(true);
        // A held file edited to an edition the platform never issued, even on a sandbox that never reported before.
        expect(policyWasReset(null, 999_999, 4)).toBe(true);
        expect(policyWasReset(4, 5, 4)).toBe(true);
    });

    it(`records a held edition the platform never issued as a reset`, async () => {
        const { admin, org, boxes } = await started();
        await call(orgRoutes.bindSandbox, { orgId: org.id, sandboxId: `sbx-1` }, { context: admin });
        const at = new Date(`2026-10-15T13:00:00Z`);
        await orgPolicyForToken(admin.prisma, `digest-1`, 999_999, at);
        expect(boxes[0]).toMatchObject({ orgPolicyApplied: null, orgPolicyResetAt: at });
        // The daemon took the policy it was sent; its next report is it catching up, not a second reset.
        await orgPolicyForToken(admin.prisma, `digest-1`, 1, new Date(`2026-10-15T13:05:00Z`));
        expect(boxes[0]).toMatchObject({ orgPolicyApplied: 1, orgPolicyResetAt: at });
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

    it(`read pinned groups in the contract's order without the ones this build does not know, and members-only only when on`, () => {
        expect(rulesOf({ sections: {}, preset: [`judge`, `telepathy`, `privacy`, 7], membersOnly: true })).toEqual({
            sections: {},
            preset: [`privacy`, `judge`],
            membersOnly: true,
        });
        expect(rulesOf({ sections: {}, preset: `privacy`, membersOnly: `yes` })).toEqual({ sections: {} });
        expect(rulesOf({ sections: {}, preset: [], membersOnly: false })).toEqual({ sections: {} });
    });

    it(`keep the invite routes off a sandbox whose organisation holds Access, and personal ones untouched`, async () => {
        const { admin, org } = await started();
        await call(orgRoutes.setPolicy, { orgId: org.id, rules: { sections: { access: `locked` } }, expectedVersion: 1 }, { context: admin });
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: org.id }, `access`)).rejects.toMatchObject({ code: `FORBIDDEN` });
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: org.id }, `secrets`)).resolves.toBeUndefined();
        await expect(refuseWhenOrgHolds(admin.prisma, { orgId: null }, `access`)).resolves.toBeUndefined();
    });
});
