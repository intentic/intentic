import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { Snapshot } from "../core/snapshot.js";
import { host } from "../host.js";
import type { OfficeService } from "./facts.js";

// The view's three requests, all to this extension's own backend: what is saved, a live refresh, a connection test.
// What is saved is a cached read keyed under `e-urzad`, the name the manifest's `files` entry invalidates: what the
// agent saves lands in the same records, so a sync the agent ran refetches it without a poll.

interface Answer {
    readonly snapshot?: Snapshot;
    readonly error?: string;
    readonly ok?: boolean;
    readonly detail?: Readonly<Record<string, string | number>>;
}

const call = async (path: string, method: `GET` | `POST`): Promise<Answer> => {
    const response = await host().backend.request(path, { method });
    // SAFETY: the backend (server/server.ts) answers this extension's own JSON shapes, errors included.
    const body = (await response.json()) as Answer;
    if (!response.ok) {
        throw new Error(body.error ?? `the e-Urząd backend answered ${response.status}`);
    }
    return body;
};

export interface Office {
    readonly snapshot: ComputedRef<Snapshot | undefined>;
    readonly error: ComputedRef<string | undefined>;
    readonly tested: Ref<string | undefined>;
    readonly pending: ComputedRef<`load` | `refresh` | `test` | undefined>;
    readonly refresh: () => Promise<void>;
    readonly test: () => Promise<void>;
}

export const useOffice = (account: () => string, service: () => OfficeService, describeTest: (detail: Readonly<Record<string, string | number>>) => string): Office => {
    const api = host();
    const failed = ref<string>();
    const tested = ref<string>();
    const active = ref<`refresh` | `test`>();
    const base = (): string => `accounts/${encodeURIComponent(account())}`;

    // `null` for an office never synced: a cached read cannot hold undefined.
    const { query, error: readError } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.key(`e-urzad`, account(), service())),
        queryFn: async () => (await call(`${base()}/overview?service=${service()}`, `GET`)).snapshot ?? null,
    });

    const pending = computed(() => active.value ?? (query.isFetching.value ? `load` : undefined));

    const guarded = async (kind: `refresh` | `test`, run: () => Promise<void>): Promise<void> => {
        if (pending.value !== undefined) {
            return;
        }
        active.value = kind;
        failed.value = undefined;
        try {
            await run();
        } catch (cause) {
            failed.value = cause instanceof Error ? cause.message : String(cause);
        } finally {
            active.value = undefined;
        }
    };

    // The sync writes the records, whose push refetches the read; asking again here covers a write the watcher missed.
    const refresh = (): Promise<void> =>
        guarded(`refresh`, async () => {
            await call(`${base()}/sync`, `POST`);
            query.refetch();
        });
    const test = (): Promise<void> =>
        guarded(`test`, async () => {
            tested.value = undefined;
            tested.value = describeTest((await call(`${base()}/test`, `POST`)).detail ?? {});
        });

    return {
        snapshot: computed(() => query.data.value ?? undefined),
        error: computed(() => failed.value ?? readError.value),
        tested,
        pending,
        refresh,
        test,
    };
};
