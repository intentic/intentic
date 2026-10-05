import {
    type Capability,
    GRANT_SHELVES,
    type GrantNeed,
    grantSite,
    type GrantShelf,
    type Need,
    type NeedAsk,
    type NeedSubject,
    type Persona,
    type PersonaPowers,
    PersonaPowersSchema,
} from "@intentic/sandbox-contract";
import type { ConversationGrants } from "../../personas/conversation-grants.js";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// Reach a conversation's persona or area withholds (docs/architecture/needs.md): a connected capability, a folder, a
// shelf of tools. A person allows it for this one conversation (conversation-grants.ts) or on the persona itself, for
// every conversation that wears it. Either way it reaches the conversation's NEXT turn, since what a turn may touch is
// decided as it starts; the conversation is continued once its current turn ends, so nobody has to say "go on".

export interface GrantNeedDeps {
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly personas: {
        readonly get: (id: string) => Promise<Persona | undefined>;
        readonly upsert: (persona: Persona) => Promise<void>;
    };
    // Read when a grant is answered, never when this is built: the store may come up after the kinds do.
    readonly grants: () => ConversationGrants;
    // The ids a persona names, by id, for resolving "the persona" in a grant's answer.
    readonly personaIdByName: (name: string) => Promise<string | undefined>;
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

const shelfOpen = (powers: PersonaPowers, shelf: GrantShelf): boolean => (shelf === "files" ? powers.files === "write" : powers[shelf]);

// The persona's shelves with one more open, each named, so the card's schema checks every one.
const openShelf = (powers: PersonaPowers, shelf: GrantShelf): PersonaPowers => {
    switch (shelf) {
        case "files":
            return { ...powers, files: "write" };
        case "shell":
            return { ...powers, shell: true };
        case "code":
            return { ...powers, code: true };
        case "web":
            return { ...powers, web: true };
        case "browser":
            return { ...powers, browser: true };
        case "delegate":
            return { ...powers, delegate: true };
        case "sandbox":
            return { ...powers, sandbox: true };
    }
};

const nextTurnUse = ["It reaches this conversation from its next turn: finish what you can now, and the sandbox continues the conversation with it."];

export const grantNeed = (deps: GrantNeedDeps): NeedKindHandler => {
    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "grant") {
            return { kind: "refused", code: "invalid", message: "Not a grant ask." };
        }
        const { standing } = context;
        const persona = standing?.persona;
        const withPersona = persona === undefined ? {} : { persona: persona.name };
        if (ask.subject === "capability") {
            const capability = (await deps.capabilities()).find((entry) => entry.id === ask.what);
            if (capability === undefined) {
                return {
                    kind: "refused",
                    code: "not_connected",
                    message: `Nothing is connected as "${ask.what}": ask for it with \`capabilities request\` instead.`,
                };
            }
            if (standing === undefined || standing.granted.includes(capability.id) || !standing.withheldByPersona.includes(capability.id)) {
                return {
                    kind: "met",
                    message: `"${capability.id}" is not withheld from this conversation: use it. If a gate holds it for an approver, \`secrets gates\` says who.`,
                };
            }
            const subject: GrantNeed = {
                kind: "grant",
                subject: "capability",
                what: capability.id,
                label: `"${capability.id}" (${capability.kind})`,
                ...withPersona,
            };
            return { kind: "raise", subject, title: `Let this conversation use "${capability.id}"` };
        }
        if (ask.subject === "folder") {
            const folder = folderOf(ask.what);
            if (folder === "" || folder.split("/").includes("..")) {
                return {
                    kind: "refused",
                    code: "invalid",
                    message: "Name a folder inside the workspace, relative to its root, such as `refs/other-repo`.",
                };
            }
            if (standing?.fence === undefined || within(folder, standing.fence)) {
                return { kind: "met", message: `This conversation already reaches ${folder}.` };
            }
            const subject: GrantNeed = { kind: "grant", subject: "folder", what: folder, label: `the folder ${folder}`, ...withPersona };
            return { kind: "raise", subject, title: `Let this conversation reach ${folder}` };
        }
        if (ask.subject === "shelf") {
            if (!isShelf(ask.what)) {
                return { kind: "refused", code: "invalid", message: `No shelf is named "${ask.what}". The shelves: ${GRANT_SHELVES.join(", ")}.` };
            }
            if (standing === undefined || shelfOpen(standing.powers, ask.what)) {
                return { kind: "met", message: `This conversation may already ${SHELF_WORDS[ask.what].verb}.` };
            }
            const subject: GrantNeed = { kind: "grant", subject: "shelf", what: ask.what, label: SHELF_WORDS[ask.what].label, ...withPersona };
            return { kind: "raise", subject, title: `Let this conversation ${SHELF_WORDS[ask.what].verb}` };
        }
        return {
            kind: "refused",
            code: "invalid",
            message: "A site in the person's own browser is asked for with the browser's own `ask_access` tool, which puts its card here by itself.",
        };
    };

    const subjectOf = (need: Need): GrantNeed | undefined => (need.subject.kind === "grant" ? need.subject : undefined);

    // Writes the grant onto the persona card itself: every conversation wearing it gets it from its next turn.
    const onPersona = async (subject: GrantNeed): Promise<string | undefined> => {
        const id = subject.persona === undefined ? undefined : await deps.personaIdByName(subject.persona);
        const persona = id === undefined ? undefined : await deps.personas.get(id);
        if (persona === undefined) {
            return "This conversation wears no persona that could take it: allow it for the conversation instead.";
        }
        const capability = subject.subject === "capability" ? (await deps.capabilities()).find((entry) => entry.id === subject.what) : undefined;
        const base: PersonaPowers = persona.powers ?? PersonaPowersSchema.parse({});
        // Undefined is "every one of them" already, so only a list the persona keeps gains the grant.
        const listed = (list: readonly string[] | undefined): string[] | undefined =>
            list === undefined ? undefined : [...new Set([...list, subject.what])];
        let next: Persona;
        if (subject.subject === "capability" && (capability?.kind === "browser" || capability?.kind === "identity")) {
            next = { ...persona, capabilities: [...new Set([...persona.capabilities, subject.what])] };
        } else if (subject.subject === "capability" && (capability?.kind === "device" || capability?.kind === "phone")) {
            next = { ...persona, powers: { ...base, devices: listed(base.devices) } };
        } else if (subject.subject === "capability" && capability?.kind === "mcp") {
            next = { ...persona, powers: { ...base, mcp: listed(base.mcp) } };
        } else if (subject.subject === "capability") {
            next = { ...persona, powers: { ...base, connectors: listed(base.connectors) } };
        } else if (subject.subject === "folder") {
            const folders = persona.workspace?.folders;
            next =
                folders === undefined
                    ? persona
                    : { ...persona, workspace: { ...persona.workspace, folders: [...new Set([...folders, subject.what])] } };
        } else if (isShelf(subject.what)) {
            next = { ...persona, powers: openShelf(base, subject.what) };
        } else {
            return `No shelf is named "${subject.what}".`;
        }
        await deps.personas.upsert(next);
        return undefined;
    };

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
        answer: async (need, answer, by) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "grant") {
                return { refused: "A grant is answered by allowing it, for this conversation or on the persona, or declined." };
            }
            if (subject.subject === "site") {
                return { refused: "A site is allowed in the person's own browser, from its Intentic extension: this card shows when it is." };
            }
            if (answer.scope === "persona") {
                const refused = await onPersona(subject);
                if (refused !== undefined) {
                    return { refused };
                }
            } else {
                await deps.grants().add(need.conversationId, { subject: subject.subject, what: subject.what }, by.email);
            }
            return {
                status: "met",
                result:
                    answer.scope === "persona"
                        ? `Allowed on the persona "${subject.persona ?? ""}": ${subject.label}.`
                        : `Allowed for this conversation: ${subject.label}.`,
                use: nextTurnUse,
            };
        },
        // A site is live in the browser the moment it is allowed; everything else reaches only the next turn's mounts.
        nextTurn: (need) => subjectOf(need)?.subject !== "site",
        key: (subject: NeedSubject) =>
            subject.kind === "grant" ? `${subject.subject}|${subject.subject === "site" ? grantSite(subject.what) : subject.what}` : "",
    };
};
