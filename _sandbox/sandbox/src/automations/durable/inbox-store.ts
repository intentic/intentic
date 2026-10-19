import { join } from "node:path";
import { z } from "zod";
import { AgentOriginSchema } from "@intentic/sandbox-contract/schemas/agent";
import { WorkspaceEventSchema } from "@intentic/sandbox-contract/schemas/automations";
import type { Services } from "../../composition.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openEntries } from "../../store/open-document.js";
import { perDaemon } from "./daemon-memory.js";

// What waits for an automation fire that has not been admitted yet, kept on the history volume so a restart cannot lose
// it: a listener message in its thread's debounce or behind a running fire (listeners.ts), a workspace event in its
// chore's queue (workspace-events.ts). A row goes once the fire that takes it is journalled (scheduler.ts, `accepted`),
// the running turn took it, or it was dropped on purpose; boot (fire-resume.ts) first drops the rows a journalled fire
// already names, then replays the rest.

const listenerEntry = z.object({
    id: z.string(),
    automationId: z.string(),
    line: z.string(),
    context: z.object({
        origin: AgentOriginSchema,
        title: z.string(),
        thread: z.string(),
        ttlMs: z.number(),
        lane: z.object({ actsAs: z.string().optional(), requireApproval: z.boolean() }),
    }),
});
const workspaceEntry = z.object({ id: z.string(), automationId: z.string(), event: WorkspaceEventSchema });

type ListenerEntry = z.infer<typeof listenerEntry>;
type WorkspaceEntry = z.infer<typeof workspaceEntry>;

export const listenerInboxDocument = defineDocument({ root: "history", path: "automation-listener-inbox.json", granularity: "entries", schema: listenerEntry });
export const workspaceInboxDocument = defineDocument({ root: "history", path: "automation-workspace-inbox.json", granularity: "entries", schema: workspaceEntry });

type Deps = Pick<Services, "config" | "automations">;

const listenerInbox = (services: Deps) => openEntries(listenerInboxDocument, join(services.config.historyRoot, listenerInboxDocument.path));
const workspaceInbox = (services: Deps) => openEntries(workspaceInboxDocument, join(services.config.historyRoot, workspaceInboxDocument.path));

// Rows this daemon wrote or replayed and is carrying in memory (daemon-memory.ts): a replay skips them, so a message that
// arrives while the boot pass runs is not fired twice.
const carriedOf = perDaemon(() => new Set<string>());

export const addListenerMessage = async (services: Deps, entry: ListenerEntry): Promise<void> => {
    carriedOf.of(services).add(entry.id);
    await listenerInbox(services).update((entries) => [...entries, entry]);
};

// A workspace event joins its chore's inbox, taking out the rows its queue just replaced or dropped.
export const addWorkspaceEvent = async (services: Deps, entry: WorkspaceEntry, removed: readonly string[]): Promise<void> => {
    const carried = carriedOf.of(services);
    carried.add(entry.id);
    for (const id of removed) {
        carried.delete(id);
    }
    await workspaceInbox(services).update((entries) => [...entries.filter((row) => !removed.includes(row.id)), entry]);
};

// A chore switched off or gone: what waited for it goes.
export const dropWorkspaceBacklog = async (services: Deps, automationId: string): Promise<void> => {
    await workspaceInbox(services).update((entries) => entries.filter((row) => row.automationId !== automationId));
};

// Lets rows go once a journalled fire carries them, or nothing will.
export const consumeInbox = async (services: Deps, ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) {
        return;
    }
    await listenerInbox(services).update((entries) => entries.filter((entry) => !ids.includes(entry.id)));
    await workspaceInbox(services).update((entries) => entries.filter((entry) => !ids.includes(entry.id)));
    const carried = carriedOf.of(services);
    for (const id of ids) {
        carried.delete(id);
    }
};

// What a restart left waiting, in arrival order, less what this daemon already carries; carried from here on.
const backlogOf = <E extends { readonly id: string }>(services: Deps, entries: readonly E[]): E[] => {
    const carried = carriedOf.of(services);
    const left = entries.filter((entry) => !carried.has(entry.id));
    for (const entry of left) {
        carried.add(entry.id);
    }
    return left;
};
export const listenerBacklog = async (services: Deps): Promise<ListenerEntry[]> => backlogOf(services, await listenerInbox(services).read());
export const workspaceBacklog = async (services: Deps): Promise<WorkspaceEntry[]> => backlogOf(services, await workspaceInbox(services).read());
