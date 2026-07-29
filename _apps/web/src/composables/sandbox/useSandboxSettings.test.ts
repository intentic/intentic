// @vitest-environment jsdom
//
// jsdom because the composable under test is only reachable through a component: useQueryClient/useQuery
// inject, so there has to be an app to mount. The rest of the suite stays on `node`.
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic-app/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

/* The settings page binds every switch — its value AND its disabled state — to this one cached object, so a
 * save that only lands once the daemon answers leaves the control the user just clicked showing stale state
 * for the whole round-trip. These tests pin the optimistic write and its rollback. */

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("./sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("./useSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`], useSandbox: () => ({ reachable: ref(true) }) }));

const { sandboxJson } = await import("./sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../queryPersistence");
const { useSandboxSettings } = await import("./useSandboxSettings");

const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});
const NEVER = new Promise<never>(() => {});

// One daemon per test: the first read answers with the stored settings, the save does whatever the test says,
// and every LATER read hangs. That last part is what makes the rollback assertion mean something — otherwise
// the refetch that follows a failed save would restore the old values on its own and prove nothing.
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

// Mount a throwaway component so the composable runs with vue-query's injection in place.
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
    // A save that stays in flight: anything the cache reports while it is pending is optimistic by definition.
    daemon(() => NEVER);
    const { save, settings } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    await vi.waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    // Still in flight — the switch moved on the click, not on the response.
    expect(save.isPending.value).toBe(true);
});

test("a field the daemon strips is NAMED, not just snapped back", async () => {
    // An older daemon: it accepts the POST and stores everything it understands, dropping the toggle its own
    // copy of the schema predates — so the reconciling read comes back without it and the control springs back
    // to 0 with no explanation. That is the bug this reports: "the input won't take a number".
    let reads = 0;
    jsonMock.mockImplementation((_path: string, init?: RequestInit) => {
        if (init?.method === `POST`) {
            return Promise.resolve({ ok: true }) as Promise<never>;
        }
        reads += 1;
        return Promise.resolve(reads === 1 ? DEFAULTS : { ...DEFAULTS, terseHoldout: undefined }) as Promise<never>;
    });
    const { save, settings, dropped } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, terseHoldout: 0.1 });

    await vi.waitFor(() => expect(settings.value?.terseHoldout).toBe(0));
    await vi.waitFor(() => expect(dropped.value).toContain(`terseHoldout`));
});

test("a rejected save rolls back, so a switch never claims a setting the sandbox refused", async () => {
    // Refused after a beat, not instantly: an immediate rejection would paint and roll back inside one tick,
    // and a test that can't observe the optimistic state in between would pass with the optimism removed.
    daemon(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Request failed (500).`)), 200)));
    const { save, settings } = mounted(() => useSandboxSettings());
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));

    save.mutate({ ...DEFAULTS, iqSearch: true });

    // Painted first, then put back when the daemon refuses it. Asserted on the rendered value rather than on
    // the mutation's status because onSettled returns its invalidate — so the mutation stays "pending" until
    // the reconciling refetch lands, which this daemon deliberately never lets happen.
    await vi.waitFor(() => expect(settings.value?.iqSearch).toBe(true));
    await vi.waitFor(() => expect(settings.value).toEqual(DEFAULTS));
});
