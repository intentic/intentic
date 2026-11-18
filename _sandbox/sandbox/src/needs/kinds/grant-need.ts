import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    GRANT_SHELVES,
    type GrantNeed,
    type GrantRole,
    grantSite,
    type GrantShelf,
    type Need,
    type NeedAsk,
    type NeedSubject,
} from "@intentic/sandbox-contract/schemas/needs";
import { BUILT_IN_ROLES, FULL_ACCESS_ROLE, type Role } from "@intentic/sandbox-contract/schemas/roles";
import { isSignedInAccount, roleAllowsCapability } from "@intentic/sandbox-contract/policy/role-capability";
import { fenceHoldsRole } from "@intentic/sandbox-contract/policy/role-home";
import { ceilingWithholds } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { foldersOf } from "../../areas/areas-store.js";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// Reach a conversation's role withholds (docs/architecture/needs.md): a connected capability, a folder, a shelf of
// tools. What a role withholds is access (an account it does not speak through, or an access profile listing it), and
// no card lifts access: the card offers the roles whose access has it instead, and a person's pick puts the
// conversation on that role from its NEXT turn, since what a turn may touch is decided as it starts. The conversation
// is continued once its current turn ends, so nobody has to say "go on". What the people and services it acts for were
// not given is refused outright: no role has more than they do.

export interface GrantNeedDeps {
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly roles: () => Promise<readonly Role[]>;
    readonly profiles: () => Promise<readonly AccessProfile[]>;
    readonly areas: () => Promise<readonly Area[]>;
    // Puts the conversation on another role (agents-registry.ts wearRole); false when there is no such conversation.
    readonly wearRole: (conversationId: string, role: string) => Promise<boolean>;
    // Whether one of the person's own browsers now lets its agent on this site (its extension's granted origins): what
    // meets a site need, which only their click in that browser can.
    readonly siteAllowed?: (site: string) => Promise<boolean>;
}

const SHELF_WORDS: Readonly<Record<GrantShelf, { readonly label: string; readonly verb: string }>> = {
    files: { label: "creating and changing files", verb: "create and change files" },
    shell: { label: "the shell", verb: "run commands" },
    code: { label: "the code runner", verb: "run scripts" },
    web: { label: "the web", verb: "fetch and search the web" },
    browser: { label: "a browser", verb: "drive a browser" },
    delegate: { label: "starting other agents", verb: "start other agents" },
    sandbox: { label: "the sandbox's own controls", verb: "manage the sandbox" },
};

const isShelf = (value: string): value is GrantShelf => (GRANT_SHELVES as readonly string[]).includes(value);

// A folder as a fence holds it: workspace-relative, forward-slash, no leading or trailing slash, whatever root prefix
// the agent saw it under.
export const folderOf = (path: string): string =>
    path
        .trim()
        .replace(/^\/(work|mnt\/intentic-main)(\/|$)/, "")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "")
        .replace(/^\/+/, "");

const within = (folder: string, fence: readonly string[]): boolean =>
    fence.some((allowed) => {
        const root = folderOf(allowed);
        return root === "" || folder === root || folder.startsWith(`${root}/`);
    });

const shelfOpen = (standing: NonNullable<AskContext["standing"]>, shelf: GrantShelf): boolean =>
    shelf === "files" ? standing.powers.files === "write" : standing.powers[shelf];

const nextTurnUse = ["It reaches this conversation from its next turn: finish what you can now, and the sandbox continues the conversation with it."];

// What a grant asks for, as a role's access is tested against it.
type Wanted =
    | { readonly kind: "capability"; readonly capability: Capability }
    | { readonly kind: "folder"; readonly folder: string }
    | { readonly kind: "shelf"; readonly shelf: GrantShelf };

// What every candidate is tested against: the cards and their access, read once per ask.
interface Candidates {
    readonly roles: readonly Role[];
    readonly profiles: readonly AccessProfile[];
    readonly areas: readonly Area[];
}

// Whether one profile listing a role allows what is wanted.
const profileAllows = (profile: AccessProfile, wanted: Wanted, areas: readonly Area[]): boolean => {
    if (wanted.kind === "capability") {
        return profile.credentials === undefined || profile.credentials.capabilities.includes(wanted.capability.id);
    }
    if (wanted.kind === "shelf") {
        return !ceilingWithholds(profile.tools, wanted.shelf);
    }
    const fence = foldersOf(areas, profile.areas);
    return fence === undefined || within(wanted.folder, fence);
};

// Whether a role, card or built-in, would have what is wanted: it speaks through the account, and every profile that
// lists a card allows the rest.
const roleHas = (id: string, card: Role | undefined, wanted: Wanted, from: Candidates): boolean => {
    if (wanted.kind === "capability" && isSignedInAccount(wanted.capability.kind)) {
        const speaks = card === undefined ? id === FULL_ACCESS_ROLE : roleAllowsCapability(wanted.capability, card.capabilities);
        if (!speaks) {
            return false;
        }
    }
    // A built-in is held to no profile, as the principal chain reads it (access/principal-chain.ts roleLimits).
    return card === undefined || from.profiles.filter((profile) => profile.roles?.includes(id) === true).every((profile) => profileAllows(profile, wanted, from.areas));
};

// The roles the conversation could be put on to have what is wanted: the built-ins, and every card its starter's
// areas reach, other than the one it wears now.
const rolesWith = (wanted: Wanted, standing: AskContext["standing"], from: Candidates): GrantRole[] => {
    const wearing = standing?.role?.id;
    const builtIns = BUILT_IN_ROLES.filter((builtIn) => builtIn.id !== wearing && roleHas(builtIn.id, undefined, wanted, from)).map((builtIn) => ({
        id: builtIn.id,
        label: builtIn.label,
    }));
    const cards = from.roles
        .filter((card) => card.id !== wearing && fenceHoldsRole(standing?.accessFence, card) && roleHas(card.id, card, wanted, from))
        .map((card) => ({ id: card.id, label: card.label ?? card.id }));
    return [...cards, ...builtIns];
};

// The card a role's withholding comes to: the roles that have it, or a refusal when none does.
const offer = (subject: Omit<GrantNeed, "kind" | "roles" | "role">, title: string, roles: GrantRole[], standing: AskContext["standing"]): Resolved => {
    if (roles.length === 0) {
        return {
            kind: "refused",
            code: "no_role",
            message: `No role this conversation could wear has ${subject.label}: only the sandbox owner can change what a role may reach, on the Access page. Carry on without it and say plainly what you left undone.`,
        };
    }
    const need: GrantNeed = { kind: "grant", ...subject, roles };
    const wearing = standing?.role?.name;
    if (wearing !== undefined) {
        need.role = wearing;
    }
    return { kind: "raise", subject: need, title };
};

const OUT_OF_REACH = "and no role changes that: only the sandbox owner does, on the Access page. Carry on without it.";

// A capability the conversation does not reach: met when nothing withholds it, refused when the people it works for
// were not given it, and otherwise the roles that have it.
const capabilityGrant = (connected: readonly Capability[], asked: string, standing: AskContext["standing"], from: Candidates): Resolved => {
    const capability = connected.find((entry) => entry.id === asked);
    if (capability === undefined) {
        return { kind: "refused", code: "not_connected", message: `Nothing is connected as "${asked}": ask for it with \`capabilities request\` instead.` };
    }
    if (standing?.withheldByReach.includes(capability.id) === true) {
        return { kind: "refused", code: "out_of_reach", message: `"${capability.id}" is not available to the people this conversation works for, ${OUT_OF_REACH}` };
    }
    if (standing === undefined || standing.granted.includes(capability.id) || !standing.withheldByRole.includes(capability.id)) {
        return {
            kind: "met",
            message: `"${capability.id}" is not withheld from this conversation: use it. If a gate holds it for an approver, \`secrets gates\` says who.`,
        };
    }
    const subject = { subject: "capability" as const, what: capability.id, label: `"${capability.id}" (${capability.kind})` };
    return offer(subject, `Switch this conversation to a role that uses "${capability.id}"`, rolesWith({ kind: "capability", capability }, standing, from), standing);
};

// A folder outside the conversation's fence: met when the fence already holds it, refused when the conversation was born
// outside it, and otherwise the roles whose access reaches it.
const folderGrant = (asked: string, standing: AskContext["standing"], from: Candidates): Resolved => {
    const folder = folderOf(asked);
    if (folder === "" || folder.split("/").includes("..")) {
        return { kind: "refused", code: "invalid", message: "Name a folder inside the workspace, relative to its root, such as `refs/other-repo`." };
    }
    if (standing?.fence === undefined || within(folder, standing.fence)) {
        return { kind: "met", message: `This conversation already reaches ${folder}.` };
    }
    if (standing.accessFence !== undefined && !within(folder, standing.accessFence)) {
        return { kind: "refused", code: "out_of_reach", message: `${folder} is outside the areas of the people this conversation works for, ${OUT_OF_REACH}` };
    }
    const subject = { subject: "folder" as const, what: folder, label: `the folder ${folder}` };
    return offer(subject, `Switch this conversation to a role that reaches ${folder}`, rolesWith({ kind: "folder", folder }, standing, from), standing);
};

// A shelf the conversation does not have: met when it is open, refused when the access it runs under holds it back
// whatever it wears, and otherwise the roles that have it.
const shelfGrant = (asked: string, standing: AskContext["standing"], from: Candidates): Resolved => {
    if (!isShelf(asked)) {
        return { kind: "refused", code: "invalid", message: `No shelf is named "${asked}". The shelves: ${GRANT_SHELVES.join(", ")}.` };
    }
    if (standing === undefined || shelfOpen(standing, asked)) {
        return { kind: "met", message: `This conversation may already ${SHELF_WORDS[asked].verb}.` };
    }
    if (ceilingWithholds(standing.ceiling, asked)) {
        return {
            kind: "refused",
            code: "out_of_reach",
            message: `This conversation may not ${SHELF_WORDS[asked].verb}: the people or the service it acts for are held back from it, ${OUT_OF_REACH}`,
        };
    }
    const subject = { subject: "shelf" as const, what: asked, label: SHELF_WORDS[asked].label };
    return offer(subject, `Switch this conversation to a role that may ${SHELF_WORDS[asked].verb}`, rolesWith({ kind: "shelf", shelf: asked }, standing, from), standing);
};

export const grantNeed = (deps: GrantNeedDeps): NeedKindHandler => {
    const candidates = async (): Promise<Candidates> => {
        const [roles, profiles, areas] = await Promise.all([deps.roles(), deps.profiles(), deps.areas()]);
        return { roles, profiles, areas };
    };
    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "grant") {
            return { kind: "refused", code: "invalid", message: "Not a grant ask." };
        }
        const { standing } = context;
        if (ask.subject === "capability") {
            return capabilityGrant(await deps.capabilities(), ask.what, standing, await candidates());
        }
        if (ask.subject === "folder") {
            return folderGrant(ask.what, standing, await candidates());
        }
        if (ask.subject === "shelf") {
            return shelfGrant(ask.what, standing, await candidates());
        }
        return {
            kind: "refused",
            code: "invalid",
            message: "A site in the person's own browser is asked for with the browser's own `ask_access` tool, which puts its card here by itself.",
        };
    };

    const subjectOf = (need: Need): GrantNeed | undefined => (need.subject.kind === "grant" ? need.subject : undefined);

    return {
        resolve,
        // Met by an answer, except a site, which the person allows in their own browser and this reads back from it.
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            if (subject?.subject !== "site" || deps.siteAllowed === undefined || !(await deps.siteAllowed(grantSite(subject.what)))) {
                return undefined;
            }
            return {
                result: `${grantSite(subject.what)} is allowed in the person's browser.`,
                use: ["Its browser tools reach the site now: carry on there."],
            };
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "grant") {
                return { refused: "A grant is answered by picking a role to switch the conversation to, or declined." };
            }
            if (subject.subject === "site") {
                return { refused: "A site is allowed in the person's own browser, from its Intentic extension: this card shows when it is." };
            }
            const picked = subject.roles?.find((role) => role.id === answer.role);
            if (picked === undefined) {
                return { refused: "Pick one of the roles the card offers." };
            }
            if (!(await deps.wearRole(need.conversationId, picked.id))) {
                return { refused: "The conversation is gone." };
            }
            return { status: "met", result: `Switched this conversation to the role ${picked.label}: ${subject.label} is within its reach.`, use: nextTurnUse };
        },
        // A site is live in the browser the moment it is allowed; everything else reaches only the next turn's mounts.
        nextTurn: (need) => subjectOf(need)?.subject !== "site",
        key: (subject: NeedSubject) =>
            subject.kind === "grant" ? `${subject.subject}|${subject.subject === "site" ? grantSite(subject.what) : subject.what}` : "",
    };
};
