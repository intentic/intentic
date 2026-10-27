import type { OrgDetail, OrgList, OrgMember, OrgRole, OrgSandbox } from "@intentic/api-contract";
import type { OrgPolicyRules } from "@intentic/sandbox-contract/schemas/organisation";
import { officeOrganisation, officeOrganisations } from "../fixture/offices/organisation";
import { DEMO_USER } from "./account";
import { rowOf } from "./sandboxRegistry";

// THE ORGANISATIONS AS LIVE STATE: the fixture's office (fixture/offices/organisation.ts), with the demo account as one
// of its admins, and any the visitor starts. The rules the platform keeps hold here as they do in org.routes.ts: a new
// edition only over the one the admin edited, never without an admin, a sandbox in one organisation at a time, bound
// only by its owner. A bound sandbox's daemon fetches each new edition a few seconds later and says it holds it, which
// is how the console's "pending" turns to "applied".

// How long a bound daemon takes to fetch a new edition and report it held.
const APPLY_MS = 4_000;

interface Org {
    id: string;
    name: string;
    policy: OrgPolicyRules;
    policyVersion: number;
    members: OrgMember[];
    sandboxes: OrgSandbox[];
}

/** Why a write was refused, in the platform's words and status. */
export interface OrgRefusal {
    readonly refused: string;
    readonly status: 403 | 404 | 409;
}

const me = DEMO_USER.email.toLowerCase();
const now = (): string => new Date().toISOString();

const orgs: Org[] = [
    {
        id: officeOrganisation.id,
        name: officeOrganisation.name,
        policy: structuredClone(officeOrganisation.policy),
        policyVersion: officeOrganisation.policyVersion,
        members: [...(officeOrganisation.members ?? []), { email: me, role: `admin`, addedAt: `2026-10-16T08:30:00.000Z` }],
        sandboxes: (officeOrganisation.sandboxes ?? []).map((sandbox) => ({ ...sandbox })),
    },
];

const roleIn = (org: Org): OrgRole | undefined => org.members.find((member) => member.email === me)?.role;

// The caller's organisation, or why it is not one of theirs; `admin` asks for the role every write needs.
export const orgFor = (orgId: string, admin = false): Org | OrgRefusal => {
    const org = orgs.find((candidate) => candidate.id === orgId);
    const role = org === undefined ? undefined : roleIn(org);
    if (org === undefined || role === undefined) {
        return { refused: `Organisation not found.`, status: 404 };
    }
    return admin && role !== `admin` ? { refused: `Only an admin of this organisation can do that.`, status: 403 } : org;
};

/** One organisation as its console reads it: the roster and the sandboxes are an admin's to see. */
export const detailOf = (org: Org): OrgDetail => {
    const role = roleIn(org) ?? `member`;
    const base: OrgDetail = { id: org.id, name: org.name, role, policy: structuredClone(org.policy), policyVersion: org.policyVersion };
    if (role === `admin`) {
        base.members = org.members.map((member) => ({ ...member }));
        base.sandboxes = org.sandboxes.map((sandbox) => ({ ...sandbox }));
    }
    return base;
};

export const orgList = (): OrgList => ({
    orgs: orgs.flatMap((org) => {
        const role = roleIn(org);
        return role === undefined ? [] : [{ id: org.id, name: org.name, role, sandboxCount: org.sandboxes.length }];
    }),
    // As the fixture's console offers it: this platform lets its accounts start one.
    canCreate: officeOrganisations.canCreate,
});

// Every bound daemon fetches the edition now current and says it holds it, a little later.
const applyLater = (org: Org): void => {
    const edition = org.policyVersion;
    setTimeout(() => {
        for (const sandbox of org.sandboxes) {
            sandbox.policyApplied = Math.max(sandbox.policyApplied ?? 0, edition);
            sandbox.lastSeenAt = now();
        }
    }, APPLY_MS);
};

// A changed roster is a new edition wherever the policy keeps sandboxes to the organisation's people.
const raiseIfMembersOnly = (org: Org): void => {
    if (org.policy.membersOnly === true) {
        org.policyVersion += 1;
        applyLater(org);
    }
};

/** org.create: the caller is its first admin, and every section starts open. */
export const createOrg = (name: string): Org => {
    const org: Org = { id: `org-${crypto.randomUUID().slice(0, 8)}`, name, policy: { sections: {} }, policyVersion: 1, members: [{ email: me, role: `admin`, addedAt: now() }], sandboxes: [] };
    orgs.push(org);
    return org;
};

/** org.setPolicy: a new edition, only over the one the admin edited. */
export const writePolicy = (org: Org, rules: OrgPolicyRules, expectedVersion: number): OrgRefusal | undefined => {
    if (org.policyVersion !== expectedVersion) {
        return { refused: `The policy changed since you opened it; reload and try again.`, status: 409 };
    }
    org.policy = structuredClone(rules);
    org.policyVersion += 1;
    applyLater(org);
    return undefined;
};

const lastAdmin = (org: Org, email: string): boolean => {
    const admins = org.members.filter((member) => member.role === `admin`);
    return admins.length === 1 && admins[0]?.email === email;
};

/** org.addMember: re-adding someone sets their role, which is also how an admin is demoted; never the last one. */
export const addMember = (org: Org, address: string, role: OrgRole): OrgRefusal | undefined => {
    const email = address.toLowerCase();
    if (role !== `admin` && lastAdmin(org, email)) {
        return { refused: `An organisation needs at least one admin; make someone else an admin before changing this one.`, status: 409 };
    }
    const existing = org.members.find((member) => member.email === email);
    if (existing !== undefined) {
        existing.role = role;
        return undefined;
    }
    org.members.push({ email, role, addedAt: now() });
    raiseIfMembersOnly(org);
    return undefined;
};

/** org.removeMember: never the last admin. Undefined once removed; the caller removing themselves has no console left. */
export const removeMember = (org: Org, address: string): OrgRefusal | undefined => {
    const email = address.toLowerCase();
    if (lastAdmin(org, email)) {
        return { refused: `An organisation needs at least one admin; add another before removing this one.`, status: 409 };
    }
    const before = org.members.length;
    org.members = org.members.filter((member) => member.email !== email);
    if (org.members.length < before) {
        raiseIfMembersOnly(org);
    }
    return undefined;
};

export const isMe = (address: string): boolean => address.toLowerCase() === me;

/** org.bindSandbox: one of the caller's own sandboxes, under one organisation at a time. */
export const bindSandbox = (org: Org, sandboxId: string): OrgRefusal | undefined => {
    const row = rowOf(sandboxId);
    if (row === undefined || row.role !== `owner`) {
        return { refused: `Sandbox not found.`, status: 404 };
    }
    if (orgs.some((other) => other !== org && other.sandboxes.some((sandbox) => sandbox.id === sandboxId))) {
        return { refused: `This sandbox already belongs to another organisation.`, status: 409 };
    }
    if (!org.sandboxes.some((sandbox) => sandbox.id === sandboxId)) {
        const bound: OrgSandbox = { id: row.id, name: row.name, ownerEmail: me };
        if (row.lastSeenAt !== null) {
            bound.lastSeenAt = row.lastSeenAt;
        }
        org.sandboxes.push(bound);
        applyLater(org);
    }
    return undefined;
};

/** org.unbindSandbox: back to personal; its daemon drops the policy at its next fetch. */
export const unbindSandbox = (org: Org, sandboxId: string): OrgRefusal | undefined => {
    const before = org.sandboxes.length;
    org.sandboxes = org.sandboxes.filter((sandbox) => sandbox.id !== sandboxId);
    return org.sandboxes.length === before ? { refused: `That sandbox is not in this organisation.`, status: 404 } : undefined;
};

/** The caller's memberships, for the account's data export. */
export const membershipsOf = (): { readonly org: string; readonly role: OrgRole; readonly addedAt: string }[] =>
    orgs.flatMap((org) => org.members.filter((member) => member.email === me).map((member) => ({ org: org.name, role: member.role, addedAt: member.addedAt })));
