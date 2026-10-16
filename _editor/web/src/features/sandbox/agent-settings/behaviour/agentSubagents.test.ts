// The three subagent ceilings, each writing its own key, and the line that says where spawning itself is decided:
// Guardrails, which also says here when it is refused, since that leaves the ceilings bounding only in-process subagents.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

const { default: AgentSubagents } = await import("./AgentSubagents.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSubagents) });
    app.use(PrimeVue);
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: { render: () => null } }] }));
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    patch.mockClear();
});

const numberBox = (host: HTMLElement, label: string): HTMLInputElement => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

test("draws the three ceilings, and sends whether it may spawn at all to Guardrails", () => {
    const host = mount();

    expect(host.querySelector(`[aria-label="Spawn subagents"]`)).toBeNull();
    for (const label of [`Subagents at once`, `Subagents per conversation`, `Nesting depth`]) {
        expect(numberBox(host, label), label).not.toBeNull();
    }
    expect(host.querySelector(`a[href="/sandbox/guardrails"]`)).not.toBeNull();
});

test("each ceiling opens on the daemon's own default", () => {
    const host = mount();
    const defaults = SandboxSettingsSchema.parse({});

    expect(numberBox(host, `Subagents at once`).value).toBe(String(defaults.subagentsAtOnce));
    expect(numberBox(host, `Subagents per conversation`).value).toBe(String(defaults.subagentsPerTurn));
    expect(numberBox(host, `Nesting depth`).value).toBe(String(defaults.subagentDepth));
});

test("a ceiling writes its own key and nothing else", async () => {
    const host = mount();
    const box = numberBox(host, `Subagents at once`);
    box.value = `5`;
    box.dispatchEvent(new Event(`change`));
    await nextTick();

    expect(patch).toHaveBeenCalledWith({ subagentsAtOnce: 5 });
});

// Refusing the spawn door leaves the runtime's own Agent tool, which the same ceilings still bound.
test("says the ceilings bound only in-process subagents while spawning is refused", async () => {
    settings.value = { ...settings.value, actionRules: { "agents.spawn": `deny` } };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`the limits below bound only the subagents a runtime starts in-process`);
});

test("says nothing of the kind while spawning runs", async () => {
    const host = mount();
    await nextTick();

    expect(settings.value.actionRules[`agents.spawn`]).toBeUndefined();
    expect(host.textContent).not.toContain(`bound only`);
});
