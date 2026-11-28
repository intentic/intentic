import { type MaybeRefOrGetter, computed, toValue } from "vue";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useTier } from "../../client/sandbox/useTier";
import { S2S_CONTACTS, S2S_ME, S2S_OUTBOX, S2S_TASKS, S2S_THREAD, S2S_THREADS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { useMessagesApi } from "./messagesApi";
import { contactsBadge, messagesBadge, unreadThreads, waitingTasks } from "./messagesView";

// The Messages tab's reads, each one shared cache entry: the hub's badge, the sandbox's attention and the Inbox read the
// same threads. No push says a message arrived yet, so the threads are read again every half minute while anything draws
// them. A guest is never shown a thread (the daemon floors them at viewer), and a daemon from before contacts serves
// none of these routes, which leaves the tab out rather than drawing it broken.

const THREADS_REFRESH_MS = 30_000;

/** Whether the daemon serves the Messages tab at all: an older one leaves the tab out. */
export const messagesServed = (): boolean => supportsRoute(`GET /s2s/threads`);

/** The threads the daemon shows the reader, and the contact requests waiting on a person. */
export const useThreads = (enabled: MaybeRefOrGetter<boolean> = true) => {
    const api = useMessagesApi();
    const { isGuest } = useTier();
    const { query, loaded } = useSandboxQuery({
        queryKey: S2S_THREADS.of(),
        queryFn: () => api.threads(),
        enabled: computed(() => toValue(enabled) && !isGuest.value && messagesServed()),
        refetchInterval: THREADS_REFRESH_MS,
    });
    const threads = computed(() => query.data.value?.threads ?? []);
    return {
        loaded,
        threads,
        /** The list as the daemon answered it, or none before it has. */
        list: computed(() => query.data.value),
        requests: computed(() => query.data.value?.requests ?? 0),
        /** Threads with something unread: what the sandbox's attention counts. */
        unread: computed(() => unreadThreads(threads.value)),
    };
};

/**
 * The tasks contacts handed this sandbox, as the daemon shows them to the reader (cut to the contacts they may use), and
 * those waiting for the owner's Allow. Read again with the threads, since no push says one arrived; a daemon from before
 * contact tasks serves no list, and its Contacts part draws none.
 */
export const useContactTasks = (enabled: MaybeRefOrGetter<boolean> = true) => {
    const api = useMessagesApi();
    const { isGuest } = useTier();
    const { query, loaded } = useSandboxQuery({
        queryKey: S2S_TASKS.of(),
        queryFn: async () => (await api.tasks()).tasks,
        enabled: computed(() => toValue(enabled) && !isGuest.value && supportsRoute(`GET /s2s/tasks`)),
        refetchInterval: THREADS_REFRESH_MS,
    });
    const tasks = computed(() => query.data.value ?? []);
    return { loaded, tasks, waiting: computed(() => waitingTasks(tasks.value)) };
};

/** What the tab and its parts are badged with: unread threads on the Inbox; waiting requests and tasks on Contacts; all of it on the tab. */
export const useMessagesBadges = () => {
    const { list, unread, requests } = useThreads();
    const { tasks } = useContactTasks();
    return {
        tab: computed(() => messagesBadge(list.value, tasks.value)),
        inbox: unread,
        contacts: computed(() => contactsBadge(requests.value, tasks.value)),
    };
};

/** One thread, with its messages, while it is open. */
export const useThread = (id: MaybeRefOrGetter<string | undefined>) => {
    const api = useMessagesApi();
    return useSandboxQuery({
        queryKey: computed(() => S2S_THREAD.of(toValue(id))),
        queryFn: () => api.thread(toValue(id) ?? ``),
        enabled: computed(() => toValue(id) !== undefined),
        refetchInterval: THREADS_REFRESH_MS,
    });
};

export const useContacts = (enabled: MaybeRefOrGetter<boolean> = true) => {
    const api = useMessagesApi();
    const { query, loaded } = useSandboxQuery({
        queryKey: S2S_CONTACTS.of(),
        queryFn: async () => (await api.contacts()).contacts,
        enabled: computed(() => toValue(enabled) && supportsRoute(`GET /s2s/contacts`)),
    });
    return { loaded, contacts: computed(() => query.data.value ?? []) };
};

/** This sandbox's own identity, read only by a maintainer, whom the daemon answers it to. */
export const useMe = (enabled: MaybeRefOrGetter<boolean>) => {
    const api = useMessagesApi();
    const { query, loaded } = useSandboxQuery({
        queryKey: S2S_ME.of(),
        queryFn: () => api.me(),
        enabled: computed(() => toValue(enabled) && supportsRoute(`GET /s2s/me`)),
    });
    return { loaded, me: computed(() => query.data.value) };
};

/** What waits in the outbox, read only by a maintainer, whom the daemon answers it to. */
export const useOutbox = (enabled: MaybeRefOrGetter<boolean>) => {
    const api = useMessagesApi();
    const { query } = useSandboxQuery({
        queryKey: S2S_OUTBOX.of(),
        queryFn: async () => (await api.outbox()).entries,
        enabled: computed(() => toValue(enabled) && supportsRoute(`GET /s2s/outbox`)),
        refetchInterval: THREADS_REFRESH_MS,
    });
    return computed(() => query.data.value ?? []);
};

// By the family's own prefix: a thread's key carries its id before the sandbox's, so `of()` would not reach it. Only the
// entries something draws are read again, which is the active sandbox's.
const stale = async (families: readonly { readonly every: readonly string[] }[]): Promise<void> => {
    await Promise.all(families.map((family) => queryClient.invalidateQueries({ queryKey: [...family.every] })));
};

/** After a send, a read, a delete or a take: the threads, the open thread and the outbox, read again by whoever draws them. */
export const threadsChanged = (): Promise<void> => stale([S2S_THREADS, S2S_THREAD, S2S_OUTBOX]);

/** After a contact was added, accepted, re-granted, blocked or removed: the contacts, and the threads' badge with them. */
export const contactsChanged = (): Promise<void> => stale([S2S_CONTACTS, S2S_THREADS]);

/** After a contact's waiting task was allowed or declined: the tasks, and the badges they count into. */
export const tasksChanged = (): Promise<void> => stale([S2S_TASKS]);

/** After the identity changed (a domain, a rotation, a recovery). */
export const identityChanged = (): Promise<void> => stale([S2S_ME]);
