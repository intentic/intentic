import { type AccessProfile, type AccessProfileEntry, type AccessProfileSaved, profileAccess } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { tierOf } from "@intentic/sandbox-contract/schemas/members";
import type { InviteRecord } from "@intentic/api-contract";
import type { AccessAsk, AccessRequest, AgentAccess, CredentialReach, EditScope, ManageRight } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import { demoManages, demoQuiet, demoTier } from "../mode";
import { DEMO_USER } from "../world/account";

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
    // The parts of the sandbox they run besides their own work; absent is none, and a maintainer runs every one.
    manages?: ManageRight[];
}

interface DemoMember extends DemoGrant {
    status: InviteRecord["status"];
    invitedAt: string;
}

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

// The reader's own row, when the demo is read below the owner: the tier it is read as and the rights it was given.
const readerRow = (role: GrantedRole): DemoMember => {
    const row: DemoMember = { email: DEMO_USER.email, role, status: `accepted`, invitedAt: ago(60) };
    if (role !== `maintainer` && demoManages.length > 0) {
        row.manages = [...demoManages];
    }
    return row;
};

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
    // Someone the owner made a co-admin, whose access only the owner or Full access changes.
    ...(demoQuiet() ? [] : [{ email: `max@acme.dev`, role: `maintainer` as const, status: `accepted` as const, invitedAt: ago(40) }]),
    // The reader themselves, when the demo is read below the owner (`?as=`): the roster holds their row too, with the
    // parts of the sandbox they were given (`?manages=`).
    ...(demoTier === `owner` ? [] : [readerRow(demoTier)]),
];

const index = (email: string): number => roster.findIndex((member) => member.email === email.toLowerCase());

// What people have asked the owner for (POST /members/requests): Jo, refused on Secrets, asked to be a maintainer two
// hours ago, which the owner's Access tab lists beside the roster. A quiet recording has nobody waiting.
const requests = new Map<string, AccessRequest>(
    demoQuiet() ? [] : [[`jo@acme.dev`, { email: `jo@acme.dev`, want: `maintainer`, place: `Secrets`, at: Date.now() - 2 * 3_600_000 }]],
);

/** Every open request, newest first. */
export const accessRequests = (): AccessRequest[] => [...requests.values()].sort((left, right) => right.at - left.at);

/** This person's open request, if they have one. */
export const accessRequestOf = (email: string): AccessRequest | undefined => requests.get(email.toLowerCase());

/** Records an ask, replacing any the person made before. */
export const askAccess = (email: string, ask: AccessAsk): void => {
    requests.set(email.toLowerCase(), { email: email.toLowerCase(), ...ask, at: Date.now() });
};

/** Answers a person's request: by a grant, a removal, or the owner dismissing it. */
export const settleAccess = (email: string): void => {
    requests.delete(email.toLowerCase());
};

/** The platform's copy: tier and invite state, never the fence. */
export const inviteRecords = (): InviteRecord[] =>
    roster.map(({ email, role, status, invitedAt, manages }) => {
        const record: InviteRecord = { email, role, status, invitedAt };
        if (manages !== undefined) {
            record.manages = [...manages];
        }
        return record;
    });

/** The daemon's copy: the enforced grant, with the areas it is fenced to: the row without the platform's invite state,
 *  copied so a reader's edits never reach the store. */
export const grants = (): DemoGrant[] => roster.map(({ status: _status, invitedAt: _invitedAt, ...grant }) => structuredClone(grant));

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

// Rights as a grant reads them: a list sets them, absent keeps the row's, and a maintainer stores none.
const rightsOf = (role: GrantedRole, asked: readonly ManageRight[] | undefined, held: DemoMember | undefined): Pick<DemoMember, "manages"> => {
    const manages = role === `maintainer` ? [] : (asked ?? held?.manages ?? []);
    return manages.length === 0 ? {} : { manages: [...manages] };
};

/** Upsert, as both stores do: granting an address that already holds access re-grades it and replaces its fence. A
 *  grant silent about the reach or the AI accounts keeps the row's and `all` lifts it, a maintainer's included
 *  (auth/members/member-row.ts). */
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
        readonly manages?: readonly ManageRight[] | undefined;
    } = {},
): void => {
    const address = email.toLowerCase();
    const at = index(address);
    const held = at === -1 ? undefined : roster[at];
    const reach = credentials === `all` ? undefined : (credentials ?? held?.credentials);
    const aiAccounts = answers.aiAccounts === `all` ? undefined : (answers.aiAccounts ?? held?.aiAccounts);
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
    Object.assign(row, rightsOf(role, answers.manages, held));
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
// Rights ride beside a profile, never in one: absent keeps the row's, as on the real roster.
export const grantProfile = (email: string, id: string, emailSignIn?: boolean, manages?: readonly ManageRight[]): void => {
    const profile = demoProfiles.find((entry) => entry.id === id);
    if (profile === undefined) { throw new Error(`Unknown profile: ${id}`); }
    const access = profileAccess(profile);
    grantAccess(email, tierOf(access), profile.areas, profile.credentials ?? `all`, { agents: access.agents, edit: access.edit === `none` ? undefined : access.edit === `all` ? `all` : [...access.edit], emailSignIn, aiAccounts: profile.aiAccounts ?? `all`, manages });
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
