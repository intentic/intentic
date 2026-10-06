// Pins the optimistic write and rollback the settings page relies on; jsdom mounts a component so vue-query's injection
// is in place.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { waitFor, stubGlobal } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import type { SandboxRpc } from "../../../client/sandbox/sandboxRpc";

stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const get = jest.fn<SandboxRpc[`settings`][`get`]>();
const set = jest.fn<SandboxRpc[`settings`][`set`]>();
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ settings: { get, set } }) }));
jest.mock("../../../client/sandbox/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true) }),
}));

const { queryClient } = await import("../../../lib/queryPersistence");
const { useSandboxSettings } = await import("./useSandboxSettings");

const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});
const NEVER = new Promise<never>(() => {});

// One read answers with stored settings; every later read hangs, so a failed save's rollback isn't masked by a refetch
// restoring old values on its own.
const daemon = (save: () => Promise<{ ok: true }>): void => {
    let reads = 0;
    get.mockImplementation(() => {
        reads += 1;
        return reads === 1 ? Promise.resolve(DEFAULTS) : NEVER;
    });
    set.mockImplementation(save);
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
    jest.resetAllMocks();
});

test("a save paints into the cache before the daemon answers, so the control never shows stale state", async () => {
    // The save never resolves, so anything the cache reports meanwhile is optimistic by definition.
    daemon(() => NEVER);
    const { save, settings } = mounted(() => useSandboxSettings());
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    await waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    expect(save.isPending.value).toBe(true);
});

test("a field the daemon strips is NAMED, not just snapped back", async () => {
    // Simulates an older daemon: the POST succeeds, but the reconciling read comes back missing the field its schema
    // predates, which the typed client's own parse then reads as that field's default.
    let reads = 0;
    get.mockImplementation(async () => {
        reads += 1;
        return reads === 1 ? DEFAULTS : SandboxSettingsSchema.parse({ ...DEFAULTS, iqSearchHoldout: undefined });
    });
    set.mockResolvedValue({ ok: true });
    const { save, settings, dropped } = mounted(() => useSandboxSettings());
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearchHoldout: 0.1 });

    await waitFor(() => expect(settings.value?.iqSearchHoldout).toBe(0));
    await waitFor(() => expect(dropped.value).toContain(`iqSearchHoldout`));
});

test("a rejected save rolls back, so a switch never claims a setting the sandbox refused", async () => {
    // Rejects after a delay, not instantly, so the optimistic state is observable before the rollback.
    daemon(() => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new SandboxHttpError(500, `Request failed (500).`)), 200)));
    const { save, settings } = mounted(() => useSandboxSettings());
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    // Asserted on the rendered value, not mutation status, since onSettled's invalidate keeps it pending until the
    // refetch (which never lands here).
    await waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));
});

test("a refused save says why, in the daemon's words, until the next save is tried", async () => {
    // What the daemon answers over a settings.json this build cannot read: the read served defaults, every write refused.
    const unreadable = `settings.json could not be read by this build (the file does not match what this build expects); fix or remove the file before anything can be written to it`;
    // Every read lands here, since the refusal is only reported once the reconciling read is back.
    get.mockResolvedValue(DEFAULTS);
    set.mockRejectedValue(new SandboxHttpError(409, unreadable));
    const { patch, settings, refusal } = mounted(() => useSandboxSettings());
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));
    expect(refusal.value).toBeUndefined();

    patch({ workspaceMap: true });

    await waitFor(() => expect(refusal.value?.detail).toBe(unreadable));
    expect(refusal.value?.title).toBe(`Couldn't save your change`);
    expect(refusal.value?.tone).toBe(`danger`);
    expect(settings.value?.workspaceMap).toBe(false);

    // A second press is a new attempt: the old reason goes while it runs.
    set.mockImplementation(() => NEVER);
    patch({ workspaceMap: true });
    await waitFor(() => expect(refusal.value).toBeUndefined());
});

test("patch sends the whole settings object with just the named fields changed", async () => {
    daemon(() => NEVER);
    const { patch, settings } = mounted(() => useSandboxSettings());
    await waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    patch({ iqSearch: true, hashlineEdits: true });

    await waitFor(() => expect(set).toHaveBeenLastCalledWith({ ...DEFAULTS, iqSearch: true, hashlineEdits: true }));
});

test("patch writes nothing before the settings have loaded", async () => {
    get.mockImplementation(() => NEVER);
    const { patch, settings } = mounted(() => useSandboxSettings());
    expect(settings.value).toBeUndefined();

    patch({ iqSearch: true });

    expect(set).toHaveBeenCalledTimes(0);
});
