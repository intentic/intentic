import { onBeforeUnmount, ref, type Ref } from "vue";
import type { Snapshot } from "../core/snapshot.js";
import { host } from "../host.js";
import type { OfficeService } from "./facts.js";

// The view's three requests, all to this extension's own backend: what is saved, a live refresh, a connection test.
// What the agent saves lands in the same records, and the manifest's `files` entry tells the view, so a sync the agent
// ran shows up without a poll.

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
    readonly snapshot: Ref<Snapshot | undefined>;
    readonly error: Ref<string | undefined>;
    readonly tested: Ref<string | undefined>;
    readonly load: () => Promise<void>;
    readonly refresh: () => Promise<void>;
    readonly test: () => Promise<void>;
}

export const useOffice = (account: () => string, service: () => OfficeService, describeTest: (detail: Readonly<Record<string, string | number>>) => string): Office => {
    const snapshot = ref<Snapshot>();
    const error = ref<string>();
    const tested = ref<string>();
    const base = (): string => `accounts/${encodeURIComponent(account())}`;

    const guarded = async (run: () => Promise<void>): Promise<void> => {
        error.value = undefined;
        try {
            await run();
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : String(cause);
        }
    };

    const load = (): Promise<void> =>
        guarded(async () => {
            snapshot.value = (await call(`${base()}/overview?service=${service()}`, `GET`)).snapshot;
        });
    const refresh = (): Promise<void> =>
        guarded(async () => {
            snapshot.value = (await call(`${base()}/sync`, `POST`)).snapshot;
        });
    const test = (): Promise<void> =>
        guarded(async () => {
            tested.value = undefined;
            tested.value = describeTest((await call(`${base()}/test`, `POST`)).detail ?? {});
        });

    const subscription = host().workspace.onDidChangeFiles(() => {
        void load();
    });
    onBeforeUnmount(() => {
        subscription.dispose();
    });
    return { snapshot, error, tested, load, refresh, test };
};
