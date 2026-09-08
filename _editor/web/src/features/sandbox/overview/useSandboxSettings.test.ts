// @vitest-environment jsdom
// Pins the optimistic write and rollback the settings page relies on; jsdom mounts a component so vue-query's injection
// is in place.
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("../client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../client/useSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`], useSandbox: () => ({ reachable: ref(true) }) }));

const { sandboxJson } = await import("../client/sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../../../lib/queryPersistence");
const { useSandboxSettings } = await import("./useSandboxSettings");

const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});
const NEVER = new Promise<never>(() => {});

// One read answers with stored settings; every later read hangs, so a failed save's rollback isn't masked by a refetch
// restoring old values on its own.
const daemon = (save: () => Promise<unknown>): void => {
    let reads = 0;
    jsonMock.mockImplementation((_path: string, init?: RequestInit) => {
        if (init?.method === `POST`) {
            return save() as Promise<never>;
        }
        reads += 1;
        return (reads === 1 ? Promise.resolve(DEFAULTS) : NEVER) as Promise<never>;
    });
};

// Mounts a throwaway component so the composable runs with vue-query's injection in place.
const mounted = <T>(composable: () => T): T => {
    let result!: T;
    const app = createApp(
        defineComponent({
            setup() {
                result = composable();
                return () => h(`div`);
            },
        }),
    );
    app.use(VueQueryPlugin, { queryClient });
    app.mount(document.createElement(`div`));
    return result;
};

beforeEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
});

test("a save paints into the cache before the daemon answers, so the control never shows stale state", async () => {
    // The save never resolves, so anything the cache reports meanwhile is optimistic by definition.
    daemon(() => NEVER);
    const { save, settings } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    await vi.waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    expect(save.isPending.value).toBe(true);
});

test("a field the daemon strips is NAMED, not just snapped back", async () => {
    // Simulates an older daemon: the POST succeeds, but the reconciling read comes back missing the field its schema
    // predates.
    let reads = 0;
    jsonMock.mockImplementation((_path: string, init?: RequestInit) => {
        if (init?.method === `POST`) {
            return Promise.resolve({ ok: true }) as Promise<never>;
        }
        reads += 1;
        return Promise.resolve(reads === 1 ? DEFAULTS : { ...DEFAULTS, iqSearchHoldout: undefined }) as Promise<never>;
    });
    const { save, settings, dropped } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearchHoldout: 0.1 });

    await vi.waitFor(() => expect(settings.value?.iqSearchHoldout).toBe(0));
    await vi.waitFor(() => expect(dropped.value).toContain(`iqSearchHoldout`));
});

test("a rejected save rolls back, so a switch never claims a setting the sandbox refused", async () => {
    // Rejects after a delay, not instantly, so the optimistic state is observable before the rollback.
    daemon(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Request failed (500).`)), 200)));
    const { save, settings } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    // Asserted on the rendered value, not mutation status, since onSettled's invalidate keeps it pending until the
    // refetch (which never lands here).
    await vi.waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));
});

test("patch sends the whole settings object with just the named fields changed", async () => {
    daemon(() => NEVER);
    const { patch, settings } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    patch({ iqSearch: true, hashlineEdits: true });

    // Reads share the same mock as the POST; wait for the POST call specifically, not whichever happened last.
    const posted = async (): Promise<SandboxSettings> => {
        const call = jsonMock.mock.calls.findLast(([, init]) => init?.method === `POST`);
        return JSON.parse(call?.[1]?.body as string) as SandboxSettings;
    };
    await vi.waitFor(async () => expect(await posted()).toEqual({ ...DEFAULTS, iqSearch: true, hashlineEdits: true }));
});

test("patch writes nothing before the settings have loaded", async () => {
    jsonMock.mockImplementation(() => NEVER as Promise<never>);
    const { patch, settings } = mounted(() => useSandboxSettings());
    expect(settings.value).toBeUndefined();

    patch({ iqSearch: true });

    expect(jsonMock.mock.calls.some(([, init]) => init?.method === `POST`)).toBe(false);
});
