// @vitest-environment jsdom
// jsdom: half of what's pinned here happens inside a mounted component (a run button naming its model from a
// computed), the rest is the same read with no component at all.
import { beforeEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref, watch } from "vue";

// `agentRunChoice(role)` is the standing answer to which model a run-button click spends, kept per job role rather
// than one shared unattended-work list, and handed to extensions as `api.models.agentRun(role)`. It is read from
// places with no Vue setup context (a computed, a click handler, an extension), which is what these tests probe;
// `pipeline-fix` here stands for any role.

const { useAgentRunPick } = await import("@intentic/ui");
const { queryClient } = await import("../../../lib/queryPersistence");
const { SANDBOX_SETTINGS } = await import("../../../lib/queryKeys");
const { providerAccounts } = await import("../accounts/providerAccounts");
const { providerModels } = await import("../accounts/providerCatalog");
const { agentRunChoice, shellModelPicking } = await import("./shellModelPicking");

// No VueQueryPlugin anywhere in this file: an app that never provides the client proves nothing under here injects
// one.
const mounted = (setup: () => () => unknown): App => {
    const app = createApp(defineComponent({ setup }));
    app.mount(document.createElement(`div`));
    return app;
};

// Live reader count for the settings entry; one is the app's own, more means a read built a second observer (a
// leak).
const settingsObservers = (): number => queryClient.getQueryCache().find({ queryKey: SANDBOX_SETTINGS.of() })?.observers.length ?? 0;

beforeEach(() => {
    vi.restoreAllMocks();
});

const ROLE = `pipeline-fix`;

test(`the standing choice is readable with no component in scope`, () => {
    expect(() => agentRunChoice(ROLE)).not.toThrow();
});

test(`a run button can re-read it from a click handler`, async () => {
    const clicked = ref(0);
    let failure: unknown;
    const app = mounted(() => {
        const pick = useAgentRunPick(() => shellModelPicking(), ROLE);
        // A watcher callback is the same context a click handler runs in: no instance, no injection.
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
        const pick = useAgentRunPick(() => shellModelPicking(), ROLE);
        return () => h(`div`, `${tick.value}:${pick.model.value.label}`);
    });
    const afterFirst = settingsObservers();
    // Mimics the daemon's write, invalidating the computed: five real re-evaluations, not cached renders.
    for (let round = 0; round < 5; round += 1) {
        queryClient.setQueryData(SANDBOX_SETTINGS.of(), { modelRoles: {}, round });
        tick.value += 1;
        await nextTick();
    }
    const afterFive = settingsObservers();
    app.unmount();

    expect([afterFirst, afterFive]).toEqual([1, 1]);
});

// The run button shows the tier that will actually run: a pin with no chosen model takes it whole (turn-resume.ts),
// but the daemon drops a Max pin with thinking off to `high` before sending (sendableEffort).
const pinned = (pin: Record<string, unknown>): void => {
    // Needs a credentialed account for the pin's provider, or the chain drops it (same as the daemon's resolver).
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc`, label: `Claude` }] as never };
    providerModels.value = {
        ...providerModels.value,
        claude: [{ label: `Claude Sonnet 4.6`, value: `claude-sonnet-4-6`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }],
    };
    queryClient.setQueryData(SANDBOX_SETTINGS.of(), { modelRoles: { [ROLE]: [pin] } });
};

test(`the standing choice keeps the pinned top tier, and names it`, () => {
    pinned({ provider: `claude`, model: `claude-sonnet-4-6`, effort: `max`, thinking: true });

    const choice = agentRunChoice(ROLE);

    expect({ provider: choice.provider, model: choice.model, effort: choice.effort, effortLabel: choice.effortLabel }).toEqual({
        provider: `claude`,
        model: `claude-sonnet-4-6`,
        effort: `max`,
        effortLabel: `Max`,
    });
});

test(`the standing choice names the tier the run will actually use when the pin refuses its own`, () => {
    pinned({ provider: `claude`, model: `claude-sonnet-4-6`, effort: `max`, thinking: false });

    const choice = agentRunChoice(ROLE);

    expect({ effort: choice.effort, effortLabel: choice.effortLabel }).toEqual({ effort: `high`, effortLabel: `High` });
});

/* AND THE REST OF THE ENTRY COMES WITH IT. The picker a caret opens configures all of these now, and the turn
 * carries all of them, so the standing answer has to be the entry as the owner wrote it: opening on a stripped
 * version would offer to undo their own setting the moment anybody pressed the panel's button, and a run bought
 * at the faster rate is a different price from the same model on its defaults. */
test(`the standing choice carries the whole pinned entry, not merely the pair and the tier`, () => {
    pinned({ provider: `claude`, model: `claude-sonnet-4-6`, harness: `claude-code`, thinking: false, fast: true });

    const choice = agentRunChoice(ROLE);

    expect({ harness: choice.harness, thinking: choice.thinking, fast: choice.fast }).toEqual({
        harness: `claude-code`,
        thinking: false,
        fast: true,
    });
});
