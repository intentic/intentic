// Pins that these composables are actually called (not just typechecked), inside a real component with a real
// QueryClient, asserting nothing throws.
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { describe, expect, it } from "vitest";
import { createRenderer, defineComponent, h, ref } from "vue";
import { bindHost } from "./host.js";
import { useDocs } from "./useDocs.js";
import { usePublish } from "./usePublish.js";
import { useRuns } from "./useRuns.js";

// Unreachable sandbox: every read rejects, `reachable()` is false, so queries stay disabled and network-free.
const stubHost = () =>
    ({
        apiVersion: `1.0.0`,
        views: { register: () => ({ dispose: () => {} }) },
        viewers: { register: () => ({ dispose: () => {} }) },
        commands: { register: () => ({ dispose: () => {} }), execute: async () => undefined },
        settings: { get: () => undefined, set: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
        sandbox: {
            request: async () => new Response(`{}`),
            json: async () => {
                throw new Error(`unreachable`);
            },
            reachable: () => false,
            key: (...parts: readonly string[]) => [...parts, `sandbox-1`],
            origin: () => undefined,
        },
        workspace: { repos: () => [], capabilities: () => [], onDidChange: () => ({ dispose: () => {} }) },
        processes: { status: async () => ({ name: ``, running: false }), start: async () => {}, stop: async () => {} },
        terminal: { open: () => {}, setOpen: () => {} },
        chat: { openSession: () => {} },
        navigate: () => {},
        theme: { mode: () => `light` as const, onDidChange: () => ({ dispose: () => {} }) },
    }) as unknown as Parameters<typeof bindHost>[0];

// Renders into stub nodes: setup is under test, not render output, so no browser environment is needed.
type StubNode = Record<string, unknown>;
const stubRenderer = createRenderer<StubNode, StubNode>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText: () => {},
    setElementText: () => {},
    insert: () => {},
    remove: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
});

// Runs `body` inside a mounted component's setup and returns whatever it threw; mounting swallows setup errors
// otherwise.
const runInComponent = (body: () => void): unknown => {
    bindHost(stubHost());
    let thrown: unknown;
    const component = defineComponent({
        setup() {
            try {
                body();
            } catch (error) {
                thrown = error;
            }
            return () => h(`div`);
        },
    });
    const app = stubRenderer.createApp(component);
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.mount({});
    app.unmount();
    return thrown;
};

describe(`the composables run at all`, () => {
    it(`useRuns initialises without reading a binding before it exists`, () => {
        // vue-query reads `refetchInterval` during `useQuery`, so anything it references must already be defined there.
        expect(runInComponent(() => void useRuns(ref(`intentic`)))).toBeUndefined();
    });

    it(`useDocs initialises for both document sources`, () => {
        expect(runInComponent(() => void useDocs(ref(`intentic`), ref(`published`)))).toBeUndefined();
        expect(runInComponent(() => void useDocs(ref(``), ref(`staged`)))).toBeUndefined();
    });

    it(`usePublish initialises`, () => {
        expect(runInComponent(() => void usePublish())).toBeUndefined();
    });

    it(`useRuns exposes an empty, non-throwing state when the sandbox is unreachable`, () => {
        let rows: unknown;
        const thrown = runInComponent(() => {
            rows = useRuns(ref(`intentic`)).rows.value;
        });
        expect(thrown).toBeUndefined();
        expect(rows).toEqual([]);
    });
});
