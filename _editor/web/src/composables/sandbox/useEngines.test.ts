// @vitest-environment jsdom
import type { EngineRow, EnginesView } from "@intentic-app/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("./sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("./useSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`], useSandbox: () => ({ reachable: ref(true) }) }));

const { sandboxJson } = await import("./sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../queryPersistence");
const { useEngines } = await import("./useEngines");

const FIXTURE_ENGINES: EnginesView = {
    engines: [
        {
            id: "codex",
            label: "Codex",
            running: { version: "0.147.0", source: "image" },
            channel: { kind: "latest" },
            offered: { version: "0.153.2", blessed: false },
            quarantined: [],
            diskBytes: 0,
        },
        {
            id: "cursor",
            label: "Cursor",
            running: { version: "1.0.28", source: "image" },
            channel: { kind: "latest" },
            offered: { version: "1.0.31", blessed: false },
            quarantined: [],
            diskBytes: 0,
        },
    ],
    listSource: "https://example.test/engines.json",
};

const mounted = <T>(composable: () => T): { result: T; unmount: () => void } => {
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
    const host = document.createElement(`div`);
    app.mount(host);
    return { result, unmount: () => app.unmount() };
};

beforeEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
});

test("in-flight update persists when navigating across views (unmount and remount)", async () => {
    let resolveUpdate: (val: unknown) => void = () => undefined;
    const updatePending = new Promise((resolve) => {
        resolveUpdate = resolve;
    });

    jsonMock.mockImplementation((path: string, init?: RequestInit) => {
        if (path === "/engines/update" && init?.method === "POST") {
            return updatePending as Promise<never>;
        }
        return Promise.resolve(FIXTURE_ENGINES) as Promise<never>;
    });

    const first = mounted(() => useEngines());
    await vi.waitFor(() => expect(first.result.engines.value.length).toBe(2));

    const codex = first.result.engines.value[0] as EngineRow;
    const updatePromise = first.result.update(codex);

    expect(first.result.isEngineUpdating(codex)).toBe(true);
    expect(first.result.isAnyBusy.value).toBe(true);

    // Simulate user navigating to another view: component unmounts
    first.unmount();

    // User navigates back: component mounts anew
    const second = mounted(() => useEngines());
    expect(second.result.isEngineUpdating(codex)).toBe(true);
    expect(second.result.isAnyBusy.value).toBe(true);

    // Complete the background update
    const updatedView: EnginesView = {
        ...FIXTURE_ENGINES,
        engines: [
            {
                ...codex,
                running: { version: "0.153.2", source: "store" },
                offered: undefined,
            },
            FIXTURE_ENGINES.engines[1]!,
        ],
    };
    resolveUpdate({ engines: updatedView });
    await updatePromise;

    await vi.waitFor(() => expect(second.result.isEngineUpdating(codex)).toBe(false));
    expect(second.result.engines.value[0]?.running.version).toBe("0.153.2");
    second.unmount();
});

test("updateAll updates all updatable engines sequentially", async () => {
    const updatedEngines: string[] = [];
    jsonMock.mockImplementation((path: string, init?: RequestInit) => {
        if (path === "/engines/update" && init?.method === "POST") {
            const body = JSON.parse(init.body as string) as { id: string };
            updatedEngines.push(body.id);
            return Promise.resolve({ engines: FIXTURE_ENGINES }) as Promise<never>;
        }
        return Promise.resolve(FIXTURE_ENGINES) as Promise<never>;
    });

    const { result, unmount } = mounted(() => useEngines());
    await vi.waitFor(() => expect(result.updatable.value.length).toBe(2));

    await result.updateAll();

    expect(updatedEngines).toEqual(["codex", "cursor"]);
    expect(result.updatingAll.value).toBe(false);
    unmount();
});
