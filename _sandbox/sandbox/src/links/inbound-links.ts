import { randomBytes, randomUUID } from "node:crypto";
import {
    LINK_TOKEN_PREFIX,
    type LinkPeer,
    LinkPeerSchema,
    type LinkTerms,
    LinkTermsSchema,
    type InboundLinkSummary,
} from "@intentic/sandbox-contract/schemas/links";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { opt } from "../opt.js";
import { wakeLinkTaskStatus } from "./link-task-status-wait.js";

// INBOUND LINKS: another of the owner's sandboxes allowed to hand this one tasks. The owner mints one (from their editor,
// usually while pairing the two sandboxes), the asking sandbox keeps its token on a `link` card, and every task it hands
// over runs here under the terms written on the link, which only this sandbox's owner changes. The token is hashed at
// rest like a control token's and shown once.
//
// A link reaches only the conversations it opened: each one is filed on the link as a task, and the link doors answer
// for nothing else (links.routes.ts). That list is the whole of a link's reach, which is why it lives with the
// credential rather than in the conversation registry.

// What a stored task remembers. `held` and the settled states are written here; whether a running task is parked on a card
// is read off its live run as it is asked (link-tasks.ts), since that moves without anything being written.
const StoredStateSchema = z.enum(["held", "running", "finished", "failed", "declined", "stopped"]);
type StoredState = z.infer<typeof StoredStateSchema>;

const StoredTaskSchema = z.object({
    // The asking side's own id for the task: asked again under it, the same task answers.
    requestId: z.string(),
    conversationId: z.string(),
    title: z.string().optional(),
    // The words the task opened with, kept whole until its first turn is said (while it waits for the owner, or between
    // filing and starting), since that turn starts from them; a boot finds a task still holding them unstarted.
    task: z.string().optional(),
    hops: z.number().int().nonnegative(),
    tainted: z.string().optional(),
    fromConversation: z.string().optional(),
    state: StoredStateSchema,
    report: z.string().optional(),
    error: z.string().optional(),
    version: z.number().int().nonnegative(),
    askedAt: z.number(),
    updatedAt: z.number(),
});
export type StoredLinkTask = z.infer<typeof StoredTaskSchema>;

const StoredLinkSchema = z.object({
    id: z.string(),
    label: z.string(),
    hash: z.string(),
    from: LinkPeerSchema.optional(),
    terms: LinkTermsSchema,
    createdAt: z.number(),
    createdBy: z.string().optional(),
    lastUsedAt: z.number().optional(),
    tasks: z.array(StoredTaskSchema),
});
type StoredLink = z.infer<typeof StoredLinkSchema>;
const StoredLinksSchema = z.object({ links: z.array(StoredLinkSchema) });
type StoredLinks = z.infer<typeof StoredLinksSchema>;

// On the history volume beside the control tokens: a file in the workspace would let a turn plant a link of its own.
export const inboundLinksDocument = defineDocument({ root: "history", path: "identity/links.json", schema: StoredLinksSchema });

// How many tasks a link keeps on file, settled ones dropping off oldest first; a live or held one is never dropped.
const TASKS_KEPT = 50;
// How much of a closing message is kept; the conversation itself holds the rest.
export const REPORT_KEPT = 20_000;
// How often lastUsedAt is written, so a busy link does not make its file a hot path.
const TOUCH_INTERVAL_MS = 60_000;

const LIVE_STATES: ReadonlySet<StoredState> = new Set(["held", "running"]);

// A presented token, resolved: which link it is and what that link is held to.
export interface ResolvedLink {
    readonly id: string;
    readonly label: string;
    readonly terms: LinkTerms;
}

// New terms as a request carries them: any field left out (or undefined) keeps what the link has.
export type LinkTermsPatch = { readonly [K in keyof LinkTerms]?: LinkTerms[K] | undefined };

export interface MintedLink {
    readonly id: string;
    readonly token: string;
}

// A task as the store files it at its first ask.
export interface NewLinkTask {
    readonly requestId: string;
    readonly conversationId: string;
    readonly title?: string | undefined;
    readonly task: string;
    readonly hops: number;
    readonly tainted?: string | undefined;
    readonly fromConversation?: string | undefined;
    readonly held: boolean;
}

// What one move of a task writes; `task: undefined` forgets its words once they are no longer needed.
export interface LinkTaskMove {
    readonly state?: StoredState;
    readonly report?: string;
    readonly error?: string | undefined;
    readonly forgetTask?: true;
}

export interface InboundLinks {
    readonly mint: (
        label: string,
        options: { readonly from?: LinkPeer | undefined; readonly terms?: LinkTermsPatch | undefined; readonly createdBy?: string | undefined },
    ) => Promise<MintedLink>;
    readonly resolve: (presented: string) => Promise<ResolvedLink | undefined>;
    readonly touch: (id: string, now?: number) => Promise<void>;
    readonly list: () => Promise<InboundLinkSummary[]>;
    readonly summary: (id: string) => Promise<InboundLinkSummary | undefined>;
    readonly update: (id: string, change: LinkTermsPatch & { readonly label?: string | undefined }) => Promise<InboundLinkSummary | undefined>;
    readonly revoke: (id: string) => Promise<boolean>;
    // The task this link opened under that request id or that conversation id, or undefined: the link's whole reach.
    readonly task: (linkId: string, key: { readonly requestId?: string; readonly conversationId?: string }) => Promise<StoredLinkTask | undefined>;
    readonly addTask: (linkId: string, task: NewLinkTask, now?: number) => Promise<StoredLinkTask | undefined>;
    readonly moveTask: (linkId: string, conversationId: string, move: LinkTaskMove, now?: number) => Promise<StoredLinkTask | undefined>;
    // Every task filed to run whose first turn was never said: the daemon stopped between filing it and starting it.
    readonly unstarted: () => Promise<readonly { readonly link: ResolvedLink; readonly task: StoredLinkTask }[]>;
    // Which link opened this conversation, for the turn's own endings to be filed against; undefined for any other.
    readonly linkOf: (conversationId: string) => Promise<{ readonly linkId: string; readonly task: StoredLinkTask } | undefined>;
}

const summaryOf = (link: StoredLink): InboundLinkSummary => ({
    id: link.id,
    label: link.label,
    ...opt("from", link.from),
    terms: link.terms,
    createdAt: link.createdAt,
    ...opt("createdBy", link.createdBy),
    ...opt("lastUsedAt", link.lastUsedAt),
    conversations: link.tasks.filter((task) => task.state !== "held" && task.state !== "declined").length,
    requests: link.tasks
        .filter((task) => task.state === "held")
        .toSorted((left, right) => left.askedAt - right.askedAt)
        .map((task) => ({
            id: task.requestId,
            conversationId: task.conversationId,
            task: (task.task ?? "").slice(0, 2_000),
            ...opt("title", task.title),
            askedAt: task.askedAt,
        })),
});

// A patch's named fields only: one left undefined keeps what is there rather than clearing it.
const definedOf = (patch: LinkTermsPatch): LinkTermsPatch => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

// A task as its first ask files it.
const filedTask = (task: NewLinkTask, now: number): StoredLinkTask => ({
    requestId: task.requestId,
    conversationId: task.conversationId,
    ...opt("title", task.title),
    // Kept until its first turn is said: the owner's yes, or a boot that finds it filed but never started, starts that
    // turn from these words (link-tasks.ts startTurn forgets them).
    ...opt("task", task.task),
    hops: task.hops,
    ...opt("tainted", task.tainted),
    ...opt("fromConversation", task.fromConversation),
    state: task.held ? "held" : "running",
    version: 1,
    askedAt: now,
    updatedAt: now,
});

// Every task filed to run whose first turn was never said, with the link it runs under.
const unstartedOf = (stored: StoredLinks): { readonly link: ResolvedLink; readonly task: StoredLinkTask }[] =>
    stored.links.flatMap((link) =>
        link.tasks
            .filter((task) => task.state === "running" && task.task !== undefined)
            .map((task) => ({ link: { id: link.id, label: link.label, terms: link.terms }, task })),
    );

// The newest TASKS_KEPT, every live one kept whatever its age.
const pruned = (tasks: readonly StoredLinkTask[]): StoredLinkTask[] => {
    const settled = tasks.filter((task) => !LIVE_STATES.has(task.state)).toSorted((left, right) => right.updatedAt - left.updatedAt);
    const dropped = new Set(settled.slice(Math.max(0, TASKS_KEPT - (tasks.length - settled.length))).map((task) => task.requestId));
    return tasks.filter((task) => !dropped.has(task.requestId));
};

export const fileInboundLinks = (path: string): InboundLinks => {
    // Refused rather than set aside when this build cannot read it, as the control tokens are: setting it aside would
    // revoke every link at once.
    const file = openDocument<typeof inboundLinksDocument, StoredLinks>(inboundLinksDocument, path, {
        unknownKeys: true,
        fallback: () => ({ links: [] }),
        onUnreadable: "refuse",
    });
    const changeLink = async (id: string, change: (link: StoredLink) => StoredLink): Promise<StoredLink | undefined> => {
        let changed: StoredLink | undefined;
        await file.update((stored) => {
            const at = stored.links.findIndex((link) => link.id === id);
            const link = stored.links[at];
            if (link === undefined) {
                return stored;
            }
            changed = change(link);
            return { links: stored.links.map((candidate, index) => (index === at ? (changed ?? candidate) : candidate)) };
        });
        return changed;
    };
    return {
        mint: async (label, options) => {
            const token = `${LINK_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
            const id = `lnk-${randomUUID()}`;
            await file.update((stored) => ({
                links: [
                    ...stored.links,
                    {
                        id,
                        label,
                        hash: sha256Hex(token),
                        ...opt("from", options.from),
                        terms: LinkTermsSchema.parse(definedOf(options.terms ?? {})),
                        createdAt: Date.now(),
                        ...opt("createdBy", options.createdBy),
                        tasks: [],
                    },
                ],
            }));
            return { id, token };
        },
        resolve: async (presented) => {
            if (!presented.startsWith(LINK_TOKEN_PREFIX)) {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe whatever was presented.
            const link = (await file.read()).links.find((candidate) => tokenEquals(candidate.hash, hash));
            return link === undefined ? undefined : { id: link.id, label: link.label, terms: link.terms };
        },
        touch: async (id, now = Date.now()) => {
            await file.update((stored) => {
                const link = stored.links.find((candidate) => candidate.id === id);
                if (link === undefined || (link.lastUsedAt !== undefined && now - link.lastUsedAt < TOUCH_INTERVAL_MS)) {
                    return stored;
                }
                return { links: stored.links.map((candidate) => (candidate.id === id ? { ...candidate, lastUsedAt: now } : candidate)) };
            });
        },
        list: async () => (await file.read()).links.map(summaryOf),
        summary: async (id) => {
            const link = (await file.read()).links.find((candidate) => candidate.id === id);
            return link === undefined ? undefined : summaryOf(link);
        },
        update: async (id, change) => {
            const { label, ...terms } = change;
            const link = await changeLink(id, (current) => ({
                ...current,
                ...opt("label", label),
                terms: LinkTermsSchema.parse({ ...current.terms, ...definedOf(terms) }),
            }));
            return link === undefined ? undefined : summaryOf(link);
        },
        revoke: async (id) => {
            let gone: StoredLink | undefined;
            await file.update((stored) => {
                gone = stored.links.find((link) => link.id === id);
                return gone === undefined ? stored : { links: stored.links.filter((link) => link.id !== id) };
            });
            // A status read held on one of its tasks answers now that the task is gone, not on its next timed look.
            for (const task of gone?.tasks ?? []) {
                wakeLinkTaskStatus(task.conversationId);
            }
            return gone !== undefined;
        },
        task: async (linkId, key) => {
            const link = (await file.read()).links.find((candidate) => candidate.id === linkId);
            return link?.tasks.find(
                (task) =>
                    (key.requestId !== undefined && task.requestId === key.requestId) || (key.conversationId !== undefined && task.conversationId === key.conversationId),
            );
        },
        addTask: async (linkId, task, now = Date.now()) => {
            let added: StoredLinkTask | undefined;
            await changeLink(linkId, (link) => {
                // Asked twice under one id: the first ask stands, and nothing is filed again.
                const earlier = link.tasks.find((candidate) => candidate.requestId === task.requestId);
                if (earlier !== undefined) {
                    added = earlier;
                    return link;
                }
                added = filedTask(task, now);
                return { ...link, tasks: pruned([...link.tasks, added]) };
            });
            return added;
        },
        moveTask: async (linkId, conversationId, move, now = Date.now()) => {
            let moved: StoredLinkTask | undefined;
            await changeLink(linkId, (link) => ({
                ...link,
                tasks: link.tasks.map((task) => {
                    if (task.conversationId !== conversationId) {
                        return task;
                    }
                    const { task: words, error: _error, report: _report, ...rest } = task;
                    moved = {
                        ...rest,
                        ...opt("task", move.forgetTask === true ? undefined : words),
                        ...opt("state", move.state),
                        // A new turn's report replaces the last; a move that names none keeps it.
                        ...opt("report", move.report?.slice(0, REPORT_KEPT) ?? task.report),
                        // An error belongs to the turn that failed: any other move clears it unless it names one.
                        ...opt("error", move.error),
                        version: task.version + 1,
                        updatedAt: now,
                    };
                    return moved;
                }),
            }));
            if (moved !== undefined) {
                wakeLinkTaskStatus(conversationId);
            }
            return moved;
        },
        unstarted: async () => unstartedOf(await file.read()),
        linkOf: async (conversationId) => {
            for (const link of (await file.read()).links) {
                const task = link.tasks.find((candidate) => candidate.conversationId === conversationId);
                if (task !== undefined) {
                    return { linkId: link.id, task };
                }
            }
            return undefined;
        },
    };
};
