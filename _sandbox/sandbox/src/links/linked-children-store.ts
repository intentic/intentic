import { LinkTaskSchema } from "@intentic/sandbox-contract/schemas/links";
import { z } from "zod";
import { opt } from "../opt.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { REPORT_KEPT } from "./inbound-links.js";

// The asking side's file of tasks handed to linked sandboxes (linked-children.ts): which far conversations this sandbox's
// agents are still waiting on, and how the settled ones ended.

// How many settled tasks the file remembers, newest first; an unsettled one is kept whatever its age.
const KEPT_SETTLED = 200;
// How many of those keep their report on file, newest first, so a wait after a restart still hands it whole.
const REPORTS_KEPT = 50;

const StoredChildSchema = z.object({
    id: z.string(),
    parent: z.string(),
    link: z.string(),
    // The card's address too, so a renamed card still finds the tasks handed over through it.
    url: z.string().optional(),
    sandbox: z.string(),
    sandboxId: z.string().optional(),
    // The far side's conversation: absent only between filing the task and the far side taking it.
    remote: z.string().optional(),
    // The ask as handed over, kept until the far side answers it: a restart in between asks again under the same request
    // id, which the far side answers with the task it already took (link-tasks.ts askTask), so nothing over there is
    // orphaned and nothing runs twice.
    asking: LinkTaskSchema.optional(),
    description: z.string().optional(),
    startedAt: z.number(),
    settledAt: z.number().optional(),
    // The report it settled on, cut to what the far side keeps, so a wait after a restart still hands it.
    report: z.string().optional(),
});
export type StoredChild = z.infer<typeof StoredChildSchema>;
// A task the far side took: everything about following it reads its conversation there.
export type AskedChild = StoredChild & { remote: string };
const StoredChildrenSchema = z.object({ children: z.array(StoredChildSchema) });
export type StoredChildren = z.infer<typeof StoredChildrenSchema>;

// On the history volume: which far conversations this sandbox's agents are still waiting on, so a restart picks the
// following up again and the parent still hears how each one ended.
export const linkedChildrenDocument = defineDocument({ root: "history", path: "links/linked-children.json", schema: StoredChildrenSchema });

// The task once the far side took it: its conversation there on file, and the ask no longer kept.
export const askedOf = (pending: StoredChild, remote: string): AskedChild => {
    const { asking: _asking, ...rest } = pending;
    return { ...rest, remote };
};

export interface ChildrenFile {
    readonly read: () => Promise<StoredChildren>;
    readonly put: (child: StoredChild) => Promise<void>;
    readonly drop: (id: string) => Promise<void>;
}

// The newest KEPT_SETTLED settled ones, the newest REPORTS_KEPT of them with their report, and every unsettled one.
const keptChildren = (children: readonly StoredChild[]): StoredChild[] => {
    const settled = children.filter((candidate) => candidate.settledAt !== undefined).toSorted((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0));
    const dropped = new Set(settled.slice(KEPT_SETTLED).map((candidate) => candidate.id));
    const unreported = new Set(settled.slice(REPORTS_KEPT).map((candidate) => candidate.id));
    return children
        .filter((candidate) => !dropped.has(candidate.id))
        .map(({ report, ...rest }) => (unreported.has(rest.id) ? rest : { ...rest, ...opt("report", report?.slice(0, REPORT_KEPT)) }));
};

// The children's file.
export const childrenFile = (path: string): ChildrenFile => {
    const file = openDocument<typeof linkedChildrenDocument, StoredChildren>(linkedChildrenDocument, path, { fallback: () => ({ children: [] }) });
    return {
        read: () => file.read(),
        put: async (child) => {
            await file.update((stored) => ({ children: keptChildren([...stored.children.filter((candidate) => candidate.id !== child.id), child]) }));
        },
        drop: async (id) => {
            await file.update((stored) => ({ children: stored.children.filter((candidate) => candidate.id !== id) }));
        },
    };
};
