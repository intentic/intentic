import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { wakeLinkTaskStatus } from "./link-task-status-wait.js";
import { filedTask, type LinkTaskMove, movedTask, type NewLinkTask, pruned, type StoredLinkTask, StoredLinkTaskSchema } from "./inbound-links.js";

/* THE TASKS OTHER SANDBOXES ROUTED HERE AS ONE OF THEIR PEOPLE (2026-11-24, docs/architecture/account-routing.md). The
 * `task` scope's taking side keeps what a link keeps for its own tasks (inbound-links.ts), keyed by (asking sandbox,
 * person) instead of by a link: that pair's task list is the whole of what its doors reach here, so the same person routed
 * from another sandbox, or another person from the same one, reaches none of it. Each task is a link task's record, moved
 * by the same rules (`filedTask`, `movedTask`, `pruned`), so a status reads the same over either door. */

const PersonRouteSchema = z.object({
    // The asking sandbox's tunnel id, as the pass names it.
    from: z.string(),
    fromName: z.string(),
    // Lower-cased.
    person: z.string(),
    tasks: z.array(StoredLinkTaskSchema),
});
type PersonRoute = z.infer<typeof PersonRouteSchema>;
const PersonTasksSchema = z.object({ routes: z.array(PersonRouteSchema) });
type PersonTasks = z.infer<typeof PersonTasksSchema>;

// On the history volume beside the links: a file in the workspace would let a turn plant a task another sandbox then
// reaches as if it had opened it.
export const personTasksDocument = defineDocument({
    root: "history",
    path: "links/person-tasks.json",
    // The conversations other sandboxes opened here as one of their people, and how each stands: part of those
    // conversations' own record, so it goes where they go.
    portability: "carry",
    schema: PersonTasksSchema,
});

// Who asked: the sandbox and the one person its pass routes as.
export interface PersonRouteKey {
    readonly from: string;
    readonly fromName: string;
    readonly person: string;
}

export interface PersonTasksStore {
    // The task this pair opened under that request id or conversation id; undefined for any other: the pair's whole reach.
    readonly task: (key: PersonRouteKey, lookup: { readonly requestId?: string; readonly conversationId?: string }) => Promise<StoredLinkTask | undefined>;
    readonly addTask: (key: PersonRouteKey, task: NewLinkTask, now?: number) => Promise<StoredLinkTask>;
    readonly moveTask: (conversationId: string, move: LinkTaskMove, now?: number) => Promise<StoredLinkTask | undefined>;
    // Every task filed to run whose first turn was never said: the daemon stopped between filing it and starting it.
    readonly unstarted: () => Promise<readonly { readonly key: PersonRouteKey; readonly task: StoredLinkTask }[]>;
    // Which pair opened this conversation; undefined for any other.
    readonly ownerOf: (conversationId: string) => Promise<{ readonly key: PersonRouteKey; readonly task: StoredLinkTask } | undefined>;
    // Every pair and its tasks: what a contact's status push looks over (links/contacts/task-push.ts).
    readonly list: () => Promise<readonly { readonly key: PersonRouteKey; readonly tasks: readonly StoredLinkTask[] }[]>;
}

const same = (route: PersonRoute, key: Pick<PersonRouteKey, "from" | "person">): boolean => route.from === key.from && route.person === key.person.toLowerCase();
const keyOf = (route: PersonRoute): PersonRouteKey => ({ from: route.from, fromName: route.fromName, person: route.person });

export const filePersonTasks = (path: string): PersonTasksStore => {
    const file = openDocument<typeof personTasksDocument, PersonTasks>(personTasksDocument, path, { fallback: () => ({ routes: [] }), onUnreadable: "refuse" });
    const find = async (conversationId: string): Promise<{ readonly key: PersonRouteKey; readonly task: StoredLinkTask } | undefined> => {
        for (const route of (await file.read()).routes) {
            const task = route.tasks.find((candidate) => candidate.conversationId === conversationId);
            if (task !== undefined) {
                return { key: keyOf(route), task };
            }
        }
        return undefined;
    };
    return {
        task: async (key, lookup) =>
            (await file.read()).routes
                .find((route) => same(route, key))
                ?.tasks.find(
                    (task) =>
                        (lookup.requestId !== undefined && task.requestId === lookup.requestId) ||
                        (lookup.conversationId !== undefined && task.conversationId === lookup.conversationId),
                ),
        addTask: async (key, task, now = Date.now()) => {
            let added = filedTask(task, now);
            await file.update((stored) => {
                const route = stored.routes.find((candidate) => same(candidate, key));
                // Asked twice under one id: the first ask stands, and nothing is filed again.
                const earlier = route?.tasks.find((candidate) => candidate.requestId === task.requestId);
                if (earlier !== undefined) {
                    added = earlier;
                    return stored;
                }
                if (route === undefined) {
                    return { routes: [...stored.routes, { from: key.from, fromName: key.fromName, person: key.person.toLowerCase(), tasks: [added] }] };
                }
                // The name it goes by now, should the asking sandbox have been renamed.
                const grown = { ...route, fromName: key.fromName, tasks: pruned([...route.tasks, added]) };
                return { routes: stored.routes.map((candidate) => (candidate === route ? grown : candidate)) };
            });
            return added;
        },
        moveTask: async (conversationId, move, now = Date.now()) => {
            let moved: StoredLinkTask | undefined;
            await file.update((stored) => ({
                routes: stored.routes.map((route) => ({
                    ...route,
                    tasks: route.tasks.map((task) => {
                        if (task.conversationId !== conversationId) {
                            return task;
                        }
                        moved = movedTask(task, move, now);
                        return moved;
                    }),
                })),
            }));
            if (moved !== undefined) {
                wakeLinkTaskStatus(conversationId);
            }
            return moved;
        },
        unstarted: async () =>
            (await file.read()).routes.flatMap((route) =>
                route.tasks.filter((task) => task.state === "running" && task.task !== undefined).map((task) => ({ key: keyOf(route), task })),
            ),
        ownerOf: find,
        list: async () => (await file.read()).routes.map((route) => ({ key: keyOf(route), tasks: route.tasks })),
    };
};
