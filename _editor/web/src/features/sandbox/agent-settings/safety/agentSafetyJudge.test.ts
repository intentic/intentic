// @vitest-environment jsdom
// AgentSafetyJudge controls commandJudge's mode; the model applying it is chosen on the Models tab and only
// named here.
import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Two connected accounts, so the fallback row has a real chain to name instead of just "Auto".
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../chat/session/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
vi.mock(`../../../chat/accounts/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

const { default: AgentSafetyJudge } = await import("./AgentSafetyJudge.vue");

// A minimal router to resolve the link to the Models tab; the app's own router carries unrelated guards.
const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
});
await router.push({ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } });
await router.isReady();

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyJudge) });
    app.use(PrimeVue);
    app.use(router);
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
    connected.value = [`codex`, `claude`];
    patch.mockClear();
});

const pill = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`button, [role="radio"], [role="tab"]`)].find((element) => element.textContent?.trim() === label)!;

// Reads the default off the schema instead of hardcoding it, so a schema change can't silently drift from the test.
test("opens on the setting's own default", () => {
    const host = mount();
    expect(SandboxSettingsSchema.parse({}).commandJudge).toBe(`on`);
    expect(host.textContent).toContain(`The verdict decides`);
});

test("moving the switch writes the mode and says what that mode does", async () => {
    const host = mount();
    pill(host, `Watch`).click();
    await nextTick();
    expect(patch).toHaveBeenCalledWith({ commandJudge: `watch` });
    expect(host.textContent).toContain(`nothing is ever held`);
});

// Which model applies the policy: the account a verdict is billed to, drawn from modelRoles.

// A sandbox with no models set still runs on the standing rule alone; nothing here should look configured.
test("says the judge has no model rather than naming one nobody chose", () => {
    const host = mount();
    // Reads the empty list off the schema instead of hardcoding it.
    expect(SandboxSettingsSchema.parse({}).modelRoles[`safety-judge`]).toBeUndefined();
    expect(host.textContent).toContain(`No model is set for the judge`);
    expect(host.textContent).toContain(`standing rule alone`);
    // Both providers are connected in this fixture; neither should be named without a pin.
    expect(host.textContent).not.toContain(`Judged by`);
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
});

test("a model pinned on the Models tab is the one this row names", async () => {
    settings.value = { ...settings.value, modelRoles: { "safety-judge": [{ provider: `codex`, model: `gpt-5.6` }] } };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`Judged by`);
    expect(host.textContent).toContain(`CODEX · GPT 5.6 Luna`);
    // A pin replaces the fallback chain rather than joining it; the fallback must not also be named.
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
});

test("reads the safety-judge list rather than another job's", async () => {
    settings.value = { ...settings.value, modelRoles: { "commit-message": [{ provider: `codex`, model: `gpt-5.6` }] } };
    const host = mount();
    await nextTick();

    // commit-message is pinned but safety-judge is not; a row reading the wrong key would still surface a model.
    expect(host.textContent).toContain(`No model is set for the judge`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
});

test("names no model in use while the judge is off", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`no model is in use`);
    expect(host.textContent).not.toContain(`Judged by`);
});

// The row offers exactly one press: a link to the tab that owns every model, not an inline editor.
test("offers no way to edit the model, only the address of the one that does", () => {
    const host = mount();

    expect(host.querySelector(`ol li`)).toBeNull();
    expect([...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`))).not.toContain(
        `Add a model for the safety judge`,
    );

    const link = host.querySelector<HTMLAnchorElement>(`a[href]`);
    expect(link?.textContent?.trim()).toBe(`Change in Models`);
    // Models is the tab's default category, so its address carries no section param.
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent`);
});
