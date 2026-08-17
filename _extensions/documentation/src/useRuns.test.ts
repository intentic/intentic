// THE TEST THAT WAS MISSING. Every other test in this package exercises pure functions, so the composables were
// typechecked but never CALLED — and `useRuns` shipped a synchronous ReferenceError: its `refetchInterval` read a
// `const` declared further down the same function, which vue-query resolves while it builds the observer, i.e.
// inside that const's temporal dead zone. The view crashed with "Cannot access 'live' before initialization" and
// nothing in CI noticed, because a type-level cycle had been broken with annotations while the runtime cycle stayed.
//
// So the assertion here is deliberately crude: CALL them, inside a real component, with a real QueryClient, and
// require that nothing throws. That is the whole class of bug this file exists to catch.
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { describe, expect, it } from "vitest";
import { createRenderer, defineComponent, h, ref } from "vue";
import { bindHost } from "./host.js";
import { useDocs } from "./useDocs.js";
import { usePublish } from "./usePublish.js";
import { useRuns } from "./useRuns.js";

/* A host that answers nothing. The composables must survive an unreachable sandbox — which is also the real first
 * state of every browser that opens the view before the daemon has registered — so every read here returns a
 * rejection and `reachable()` is false, keeping the queries disabled and the test free of network. */
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

/* A renderer over nothing, in place of a DOM. What is under test is what SETUP does — the composables and the
 * plugin backing them — and the host component's output is incidental to that, so it renders into stub nodes and
 * this package needs no browser environment at all.
 *
 * That is not a saving of milliseconds. Vitest builds a file's environment INSIDE the fork's start budget, and
 * that budget is 60s hardcoded in the pool, with no config to raise it; jsdom on a runner with every core busy
 * has measured ~45s of it (the number is recorded in _editor/web/vitest.config.ts). This file and
 * docPresence.test.ts were the only two here that asked for jsdom, and they are the only two that have ever
 * failed to START a worker in CI — twice, while the six node suites beside them ran to completion. A budget
 * nobody can raise is one to stop spending. */
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

// Mount a component whose setup runs `body`, and surface whatever it threw. Mounting swallows setup errors into
// the app's warn handler, so the throw is captured explicitly rather than relied upon to propagate.
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
        // The regression: vue-query calls refetchInterval during useQuery, so anything it reads must already be
        // defined at that point in the function body.
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
        // No runs, and reading the computed must not have needed any of the disabled queries to have resolved.
        expect(rows).toEqual([]);
    });
});
