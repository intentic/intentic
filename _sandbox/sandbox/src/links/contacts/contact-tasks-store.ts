import { z } from "zod";
import { filedTask, type LinkTaskMove, movedTask, type NewLinkTask, pruned, type StoredLinkTask, StoredLinkTaskSchema } from "../inbound-links.js";
import { wakeLinkTaskStatus } from "../link-task-status-wait.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

/* THE TASKS SANDBOX-SCOPED CONTACTS HANDED THIS ONE (2026-11-27, docs/architecture/messages.md "Tasks"): what a link keeps
 * for its own tasks (links/inbound-links.ts), keyed by the contact instead of by a link token. A contact's list is the
 * whole of what its `task.*` messages reach here, so one contact never reaches another's task. Each task is a link task's
 * record, moved by the same rules (`filedTask`, `movedTask`, `pruned`), so a status reads the same whichever way it came.
 * A person-scoped contact's tasks are a person's routed tasks instead (links/person-tasks-store.ts, keyed
 * `contact:<id>`), since what runs there is that person's own work. */

const ContactTasksSchema = z.object({
    contacts: z.array(
        z.object({
            // The contact's id here (contacts-store.ts).
            contact: z.string(),
            tasks: z.array(StoredLinkTaskSchema),
        }),
    ),
});
type ContactTasks = z.infer<typeof ContactTasksSchema>;

// On the history volume beside the contacts: a file in the workspace would let a turn plant a task a contact then reaches.
export const contactTasksDocument = defineDocument({
    root: "history",
    path: "s2s/contact-tasks.json",
    // The conversations contacts opened here, and how each stands: part of those conversations' own record, so it goes
    // where they go.
    portability: "carry",
    schema: ContactTasksSchema,
});

export interface ContactTasksStore {
    // The task this contact opened under that request id or conversation id; undefined for any other: its whole reach.
    readonly task: (contactId: string, key: { readonly requestId?: string; readonly conversationId?: string }) => Promise<StoredLinkTask | undefined>;
    // Asked twice under one request id, the first ask stands and nothing is filed again.
    readonly addTask: (contactId: string, task: NewLinkTask, now?: number) => Promise<StoredLinkTask>;
    readonly moveTask: (contactId: string, conversationId: string, move: LinkTaskMove, now?: number) => Promise<StoredLinkTask | undefined>;
    // A link's tasks, whole, once the link became this contact (links/upgrade/): each keeps its state and version, and one
    // already filed under its request id stands.
    readonly adopt: (contactId: string, tasks: readonly StoredLinkTask[]) => Promise<void>;
    // Every task filed to run whose first turn was never said: the daemon stopped between filing it and starting it.
    readonly unstarted: () => Promise<readonly { readonly contact: string; readonly task: StoredLinkTask }[]>;
    // Which contact opened this conversation, under the name the link task code reads (`linkId`); undefined for any other.
    readonly linkOf: (conversationId: string) => Promise<{ readonly linkId: string; readonly task: StoredLinkTask } | undefined>;
    readonly list: () => Promise<readonly { readonly contact: string; readonly tasks: readonly StoredLinkTask[] }[]>;
}

const matches = (task: StoredLinkTask, key: { readonly requestId?: string; readonly conversationId?: string }): boolean =>
    (key.requestId !== undefined && task.requestId === key.requestId) || (key.conversationId !== undefined && task.conversationId === key.conversationId);

export const fileContactTasks = (path: string): ContactTasksStore => {
    // Refused rather than set aside when this build cannot read it: setting it aside would orphan every task a contact
    // waits on.
    const file = openDocument<typeof contactTasksDocument, ContactTasks>(contactTasksDocument, path, { fallback: () => ({ contacts: [] }), onUnreadable: "refuse" });
    return {
        task: async (contactId, key) =>
            (await file.read()).contacts.find((entry) => entry.contact === contactId)?.tasks.find((task) => matches(task, key)),
        addTask: async (contactId, task, now = Date.now()) => {
            let added = filedTask(task, now);
            await file.update((stored) => {
                const entry = stored.contacts.find((candidate) => candidate.contact === contactId);
                const earlier = entry?.tasks.find((candidate) => candidate.requestId === task.requestId);
                if (earlier !== undefined) {
                    added = earlier;
                    return stored;
                }
                if (entry === undefined) {
                    return { contacts: [...stored.contacts, { contact: contactId, tasks: [added] }] };
                }
                const grown = { ...entry, tasks: pruned([...entry.tasks, added]) };
                return { contacts: stored.contacts.map((candidate) => (candidate === entry ? grown : candidate)) };
            });
            return added;
        },
        moveTask: async (contactId, conversationId, move, now = Date.now()) => {
            let moved: StoredLinkTask | undefined;
            await file.update((stored) => ({
                contacts: stored.contacts.map((entry) =>
                    entry.contact !== contactId
                        ? entry
                        : {
                              ...entry,
                              tasks: entry.tasks.map((task) => {
                                  if (task.conversationId !== conversationId) {
                                      return task;
                                  }
                                  moved = movedTask(task, move, now);
                                  return moved;
                              }),
                          },
                ),
            }));
            if (moved !== undefined) {
                wakeLinkTaskStatus(conversationId);
            }
            return moved;
        },
        adopt: async (contactId, tasks) => {
            if (tasks.length === 0) {
                return;
            }
            await file.update((stored) => {
                const entry = stored.contacts.find((candidate) => candidate.contact === contactId);
                const held = new Set(entry?.tasks.map((task) => task.requestId));
                const grown = pruned([...(entry?.tasks ?? []), ...tasks.filter((task) => !held.has(task.requestId))]);
                return entry === undefined
                    ? { contacts: [...stored.contacts, { contact: contactId, tasks: grown }] }
                    : { contacts: stored.contacts.map((candidate) => (candidate === entry ? { ...entry, tasks: grown } : candidate)) };
            });
        },
        unstarted: async () =>
            (await file.read()).contacts.flatMap((entry) =>
                entry.tasks.filter((task) => task.state === "running" && task.task !== undefined).map((task) => ({ contact: entry.contact, task })),
            ),
        linkOf: async (conversationId) => {
            for (const entry of (await file.read()).contacts) {
                const task = entry.tasks.find((candidate) => candidate.conversationId === conversationId);
                if (task !== undefined) {
                    return { linkId: entry.contact, task };
                }
            }
            return undefined;
        },
        list: async () => (await file.read()).contacts,
    };
};
