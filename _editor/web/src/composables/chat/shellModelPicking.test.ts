// @vitest-environment jsdom
//
// jsdom because half of what is pinned here is what happens INSIDE a mounted component — a run button naming
// its model from a computed — and the other half is the same read with no component at all.
import { beforeEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref, watch } from "vue";

/* WHAT THE RUN BUTTONS READ, AND FROM WHERE. `agentRunChoice` is the standing answer to "which model will this
 * click spend" — pressed by both Fix buttons, Maintenance, Documentation, Acceptance and a failed pre-push
 * check, and handed to every extension as `api.models.agentRun()`.
 *
 * It is a READ, and these tests are about the places it is read from. Vue offers an injection context only
 * inside a setup, and none of the callers are one: `useAgentRunPick` reads it in a computed, the caret reads it
 * again from a click handler, and an extension may ask from anywhere at all. Underneath sits vue-query, which
 * needs that context and which builds a query observer per call — so a per-call implementation both threw and
 * leaked, and the Pipelines board (twenty rows, each with a Fix button) showed exactly that: a crashed
 * extension over a console filling with "vue-query hooks can only be used inside setup()", behind an
 * ever-growing pile of pollers for one settings object. */

const { useAgentRunPick } = await import("@intentic/ui");
const { queryClient } = await import("../queryPersistence");
const { SANDBOX_SETTINGS } = await import("../queryKeys");
const { agentRunChoice, shellModelPicking } = await import("./shellModelPicking");

// No VueQueryPlugin anywhere in this file, on purpose: an app that never provides the client is the sharpest
// statement that nothing under here injects one.
const mounted = (setup: () => () => unknown): App => {
    const app = createApp(defineComponent({ setup }));
    app.mount(document.createElement(`div`));
    return app;
};

// How many live readers the settings entry has. One is the app's own; anything more is a leak, because the
// only thing that could have added it is a read that built a second one.
const settingsObservers = (): number => queryClient.getQueryCache().find({ queryKey: SANDBOX_SETTINGS.of() })?.observers.length ?? 0;

beforeEach(() => {
    vi.restoreAllMocks();
});

test(`the standing choice is readable with no component in scope`, () => {
    expect(() => agentRunChoice()).not.toThrow();
});

test(`a run button can re-read it from a click handler`, async () => {
    const clicked = ref(0);
    let failure: unknown;
    const app = mounted(() => {
        const pick = useAgentRunPick(() => shellModelPicking());
        // A watcher callback is the same context a click handler runs in — no instance, no injection.
        watch(clicked, () => {
            try {
                void pick.model.value.label;
            } catch (error) {
                failure = error;
            }
        });
        return () => h(`div`);
    });
    clicked.value += 1;
    await nextTick();
    app.unmount();

    expect(failure).toBeUndefined();
});

test(`re-reading it never adds a second reader of the settings`, async () => {
    const tick = ref(0);
    const app = mounted(() => {
        const pick = useAgentRunPick(() => shellModelPicking());
        return () => h(`div`, `${tick.value}:${pick.model.value.label}`);
    });
    const afterFirst = settingsObservers();
    // A settings write is what the daemon's own answer does, and it is what invalidates the computed the
    // button reads — so this is five genuine re-evaluations, not five renders of a cached one.
    for (let round = 0; round < 5; round += 1) {
        queryClient.setQueryData(SANDBOX_SETTINGS.of(), { agentRunModels: [], round });
        tick.value += 1;
        await nextTick();
    }
    const afterFive = settingsObservers();
    app.unmount();

    expect([afterFirst, afterFive]).toEqual([1, 1]);
});
