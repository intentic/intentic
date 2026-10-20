import { join } from "node:path";
import { z } from "zod";
import { AgentOriginSchema } from "@intentic/sandbox-contract/schemas/agent";
import { WorkspaceEventSchema } from "@intentic/sandbox-contract/schemas/automations";
import type { Services } from "../../composition.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openEntries } from "../../store/open-document.js";

// What waits for an automation fire that has not been admitted yet, kept on the history volume so a restart cannot lose
// it: a listener message in its thread's debounce or behind a running fire (listeners.ts), a workspace event in its
// chore's queue (workspace-events.ts). A row goes once the fire that takes it is journalled (scheduler.ts, `accepted`),
// the running turn took it, or it was dropped on purpose; boot replays the rest, less the rows a journalled fire already
// names, from what it read before the gate opened (fire-resume.ts), so a row this daemon wrote is never replayed.

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

export type ListenerEntry = z.infer<typeof listenerEntry>;
export type WorkspaceEntry = z.infer<typeof workspaceEntry>;

export const listenerInboxDocument = defineDocument({
    root: "history",
    path: "automation-listener-inbox.json",
    // What waits for an automation fire not journalled yet: a channel message in its debounce or behind a running fire,
    // a workspace event behind its chore. Travels with the turn journal in conversations.db, which names the rows a
    // fire already took.
    portability: "carry",
    granularity: "entries",
    schema: listenerEntry,
});
export const workspaceInboxDocument = defineDocument({
    root: "history",
    path: "automation-workspace-inbox.json",
    portability: "carry",
    granularity: "entries",
    schema: workspaceEntry,
});

type Deps = Pick<Services, "config">;

const listenerInbox = (services: Deps) => openEntries(listenerInboxDocument, join(services.config.historyRoot, listenerInboxDocument.path));
const workspaceInbox = (services: Deps) => openEntries(workspaceInboxDocument, join(services.config.historyRoot, workspaceInboxDocument.path));

export const addListenerMessage = async (services: Deps, entry: ListenerEntry): Promise<void> => {
    await listenerInbox(services).update((entries) => [...entries, entry]);
};

// A workspace event joins its chore's inbox, taking out the rows its queue just replaced or dropped.
export const addWorkspaceEvent = async (services: Deps, entry: WorkspaceEntry, removed: readonly string[]): Promise<void> => {
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
};

// Every row waiting, in arrival order.
export const listenerInboxRows = async (services: Pick<Services, "config">): Promise<ListenerEntry[]> => listenerInbox(services).read();
export const workspaceInboxRows = async (services: Pick<Services, "config">): Promise<WorkspaceEntry[]> => workspaceInbox(services).read();
