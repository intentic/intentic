import { type AccessProfile, type AccessProfileEntry, type AccessProfileSaved, profileAccess } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { tierOf } from "@intentic/sandbox-contract/schemas/members";
import type { InviteRecord } from "@intentic/api-contract";
import type { AgentAccess, CredentialReach, EditScope } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract/schemas/secrets";
import { demoQuiet } from "../mode";

// THE SHARED ACCESS ROSTER: the Access tab reads two copies of who may reach this sandbox — the platform's record
// (tier, invite state) and the daemon's enforced grant (the one that knows the fence) — and the tab only makes sense
// when the two agree. One store here, read by both seams (platform.ts, daemon.ts), is what keeps them agreeing
// through a grant, a re-grade and a revoke.

// The daemon's row: an area list only where it was granted, as the real store writes it (auth/auth.ts memberRow).
// Absent areas are the whole workspace, which is what an unnarrowed grant means — and with it every assistant, since
// which cards a person may wear is read off this fence rather than listed per person.
export interface DemoGrant {
    profile?: string;
    tools?: ToolCeiling;
    assistants?: string[];
    email: string;
    role: GrantedRole;
    areas?: string[];
    // Whether they run agents and where they edit by hand; absent, what the role meant (sandbox-contract memberAccess).
    agents?: AgentAccess;
    edit?: EditScope;
    // Whether an emailed code opens the sandbox for them; absent is no, and a grant silent about it keeps the row's.
    emailSignIn?: boolean;
    // What their assistants may spend; absent is every connected account and secret, as on the real roster.
    credentials?: CredentialReach;
    // Which AI accounts their turns run on, keyed `provider:account`; absent is every one, as on the real roster.
    aiAccounts?: string[];
}

interface DemoMember extends DemoGrant {
    status: InviteRecord["status"];
    invitedAt: string;
}

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

// Three states worth seeing at once: an accepted collaborator, a guest fenced to the one area Maya works in, and an
// invite still out. A quiet recording (mode.ts `demoQuiet`) is the ordinary team without the fenced guest, whose row
// carries a fence, an area chip and the persona she talks to: a teammate and an invite are the whole of what sharing is.
// Jo's assistants are held to the code host and the error tracker, and Jo's turns to the second Claude subscription: the
// row says so in its line, and the panel opens on those ticked.
const roster: DemoMember[] = [
    {
        email: `jo@acme.dev`,
        profile: `engineering`,
        role: `collaborator`,
        credentials: { capabilities: [`github`, `sentry`], secrets: [`SENTRY_DSN`] },
        aiAccounts: [`claude:acc_claude_demo_2`],
        status: `accepted`,
        invitedAt: ago(26),
    },
    ...(demoQuiet() ? [] : [{ email: `sam@acme.dev`, role: `guest` as const, areas: [`support`], status: `accepted` as const, invitedAt: ago(9) }]),
    { email: `rin@acme.dev`, role: `viewer`, status: `pending`, invitedAt: ago(1) },
];

const index = (email: string): number => roster.findIndex((member) => member.email === email.toLowerCase());

/** The platform's copy: tier and invite state, never the fence. */
export const inviteRecords = (): InviteRecord[] =>
    roster.map(({ email, role, status, invitedAt }) => ({ email, role, status, invitedAt }));

/** The daemon's copy: the enforced grant, with the areas it is fenced to. */
export const grants = (): DemoGrant[] =>
    roster.map(({ email, role, areas, agents, edit, emailSignIn, credentials, aiAccounts, profile, tools, assistants }) => {
        const grant: DemoGrant = { email, role, ...(profile === undefined ? {} : { profile }), ...(tools === undefined ? {} : { tools }), ...(assistants === undefined ? {} : { assistants }) };
        if (emailSignIn === true) {
            grant.emailSignIn = true;
        }
        if (areas !== undefined) {
            grant.areas = [...areas];
        }
        if (agents !== undefined) {
            grant.agents = agents;
        }
        if (edit !== undefined) {
            grant.edit = edit === `all` ? `all` : [...edit];
        }
        if (credentials !== undefined) {
            grant.credentials = credentials;
        }
        if (aiAccounts !== undefined) {
            grant.aiAccounts = [...aiAccounts];
        }
        return grant;
    });

// The answers a grant leaves on the row, as the real store writes them: sign-in kept when the grant is silent, and no
// agents or edit answer on a maintainer, whose tier is every answer.
const answersOf = (
    role: GrantedRole,
    answers: { readonly agents?: AgentAccess | undefined; readonly edit?: EditScope | undefined; readonly emailSignIn?: boolean | undefined },
    held: DemoMember | undefined,
): Partial<Pick<DemoMember, "agents" | "edit" | "emailSignIn">> => {
    const kept: Partial<Pick<DemoMember, "agents" | "edit" | "emailSignIn">> = {};
    if (answers.emailSignIn ?? held?.emailSignIn === true) {
        kept.emailSignIn = true;
    }
    if (role === `maintainer`) {
        return kept;
    }
    if (answers.agents !== undefined) {
        kept.agents = answers.agents;
    }
    if (answers.edit !== undefined) {
        kept.edit = answers.edit;
    }
    return kept;
};

/** Upsert, as both stores do: granting an address that already holds access re-grades it and replaces its fence. A
 *  grant silent about the reach or the AI accounts keeps the row's, `all` lifts it, and a maintainer holds neither
 *  (auth.ts memberRow). */
export const grantAccess = (
    email: string,
    role: GrantedRole,
    areas: readonly string[] | undefined,
    credentials?: CredentialReach | `all`,
    answers: {
        readonly agents?: AgentAccess | undefined;
        readonly edit?: EditScope | undefined;
        readonly emailSignIn?: boolean | undefined;
        readonly aiAccounts?: readonly string[] | `all` | undefined;
    } = {},
): void => {
    const address = email.toLowerCase();
    const at = index(address);
    const held = at === -1 ? undefined : roster[at];
    const reach = role === `maintainer` || credentials === `all` ? undefined : (credentials ?? held?.credentials);
    const aiAccounts = role === `maintainer` || answers.aiAccounts === `all` ? undefined : (answers.aiAccounts ?? held?.aiAccounts);
    const row: DemoMember = {
        email: address,
        role,
        status: held?.status ?? `pending`,
        invitedAt: held?.invitedAt ?? new Date().toISOString(),
    };
    if (areas !== undefined) {
        row.areas = [...areas];
    }
    if (reach !== undefined) {
        row.credentials = reach;
    }
    if (aiAccounts !== undefined) {
        row.aiAccounts = [...aiAccounts];
    }
    Object.assign(row, answersOf(role, answers, held));
    if (at === -1) {
        roster.push(row);
    } else {
        roster[at] = row;
    }
};

export const revokeAccess = (email: string): void => {
    const at = index(email);
    if (at !== -1) {
        roster.splice(at, 1);
    }
};

/** The secrets inventory: the connections' own credentials, three values the owner keeps and one the sandbox made, so
 *  the Secrets page and the person dialog's reach both read as a working sandbox's. */
export const demoSecretInventory = (): SecretInventoryEntry[] => [
    ...[`github`, `postgres`, `sentry`, `discord`, `stripe`].map((key) => ({
        key,
        kind: `capability` as const,
        status: `connected` as const,
        requiredBy: [],
        storedAt: `the capability vault`,
        revealable: true,
    })),
    ...[`DATABASE_URL`, `SENTRY_DSN`, `STRIPE_WEBHOOK_SECRET`].map((key) => ({
        key,
        kind: `env` as const,
        status: `set` as const,
        requiredBy: [],
        storedAt: `the sandbox's own store`,
        revealable: true,
    })),
    { key: `SESSION_SECRET`, kind: `generated`, status: `set`, requiredBy: [], storedAt: `generated by the sandbox`, revealable: true },
];

// Sample access for the editor demo; shared by the typed routes and roster writes.
const demoProfiles: AccessProfileEntry[] = [
    { id: `engineering`, label: `Engineering`, brief: `Build and review with the team’s code tools`, origin: `sandbox`, agents: `run`, credentials: { capabilities: [`github`, `sentry`], secrets: [`SENTRY_DSN`] }, aiAccounts: [`claude:acc_claude_demo_2`], tools: { sandbox: false } },
    { id: `support-chat`, label: `Support assistants`, brief: `Ask the assistants working in support`, origin: `sandbox`, agents: `chat`, areas: [`support`], credentials: { capabilities: [], secrets: [] } },
    { id: `org-reader`, label: `Organisation reader`, brief: `Read and search without commands`, origin: `org`, agents: `run`, tools: { files: `read`, shell: false, code: false } },
];
const demoServices: Service[] = [
    { id: `nightly-review`, label: `Nightly review`, brief: `Review changes overnight`, steward: `ada@acme.dev`, profile: `engineering` },
    { id: `support-desk`, label: `Support desk`, steward: `jo@acme.dev`, profile: `support-chat` },
];
export const grantProfile = (email: string, id: string, emailSignIn?: boolean): void => {
    const profile = demoProfiles.find((entry) => entry.id === id);
    if (profile === undefined) { throw new Error(`Unknown profile: ${id}`); }
    const access = profileAccess(profile);
    grantAccess(email, tierOf(access), profile.areas, profile.credentials ?? `all`, { agents: access.agents, edit: access.edit === `none` ? undefined : access.edit === `all` ? `all` : [...access.edit], emailSignIn, aiAccounts: profile.aiAccounts ?? `all` });
    const row = roster[index(email)];
    if (row !== undefined) { row.profile = id; row.tools = profile.tools; row.assistants = profile.assistants; }
};
const saveDemoProfile = (profile: AccessProfile): AccessProfileSaved => {
    const at = demoProfiles.findIndex((entry) => entry.id === profile.id);
    if (demoProfiles[at]?.origin === `org`) { throw new Error(`Managed by the organisation`); }
    if (at === -1) { demoProfiles.push({ ...profile, origin: `sandbox` }); }
    else { demoProfiles[at] = { ...profile, origin: `sandbox` }; }
    // A profile never manages, so its tier is never a maintainer's; narrowed here rather than asserted.
    const role = tierOf(profileAccess(profile));
    if (role === `maintainer`) { return { ok: true, holders: [] }; }
    const holders = roster.filter((member) => member.profile === profile.id).map((member) => ({ email: member.email, role }));
    for (const holder of holders) { grantProfile(holder.email, profile.id, roster[index(holder.email)]?.emailSignIn); }
    return { ok: true as const, holders };
};
const removeDemoProfile = (id: string): void => {
    if (roster.some((member) => member.profile === id) || demoServices.some((service) => service.profile === id)) { throw new Error(`Profile is held by a person or service`); }
    const at = demoProfiles.findIndex((profile) => profile.id === id);
    if (demoProfiles[at]?.origin === `org`) { throw new Error(`Managed by the organisation`); }
    if (at !== -1) { demoProfiles.splice(at, 1); }
};
const saveDemoService = (service: Service): void => {
    const at = demoServices.findIndex((entry) => entry.id === service.id);
    if (at === -1) { demoServices.push(service); } else { demoServices[at] = service; }
};
const removeDemoService = (id: string): void => {
    const at = demoServices.findIndex((entry) => entry.id === id);
    if (at !== -1) { demoServices.splice(at, 1); }
};

// The daemon's `/access/profiles` and `/access/services` routes over the stores above, spread into the fixture router
// (daemon/procedures.ts) beside the rest.
export const accessDoors = {
    accessProfiles: {
        list: () => ({ profiles: demoProfiles }),
        save: (profile: AccessProfile) => saveDemoProfile(profile),
        remove: ({ id }: { readonly id: string }) => {
            removeDemoProfile(id);
            return { ok: true as const };
        },
    },
    services: {
        list: () => ({ services: demoServices }),
        save: (service: Service) => {
            saveDemoService(service);
            return { ok: true as const };
        },
        remove: ({ id }: { readonly id: string }) => {
            removeDemoService(id);
            return { ok: true as const };
        },
    },
};
