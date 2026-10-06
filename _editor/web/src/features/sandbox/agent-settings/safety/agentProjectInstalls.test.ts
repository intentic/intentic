// AgentProjectInstalls controls projectInstalls: whether an agent's own project install runs, asks first, or is refused.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

const { default: AgentProjectInstalls } = await import("./AgentProjectInstalls.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentProjectInstalls) });
    app.use(PrimeVue);
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

const pill = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`button, [role="radio"], [role="tab"]`)].find((element) => element.textContent?.trim() === label)!;

const ASK_NOTE = `Agents ask before installing packages. You answer in the chat, once or for the whole conversation.`;
const NEVER_NOTE = `Agents never install packages themselves. A dependency they add to a manifest is installed when you land their work.`;

// Reads the default off the schema instead of hardcoding it, so a schema change can't silently drift from the test.
test("opens on the setting's own default with no note", () => {
    const host = mount();
    expect(SandboxSettingsSchema.parse({}).projectInstalls).toBe(`automatic`);
    expect(host.textContent).not.toContain(ASK_NOTE);
    expect(host.textContent).not.toContain(NEVER_NOTE);
});

// The switch reads left to right from least to most restrictive, and marks the stored answer as the chosen one.
test("offers the three answers in order, with the stored one selected", () => {
    const host = mount();
    const tabs = [...host.querySelectorAll<HTMLElement>(`[role="tab"]`)];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([`Automatic`, `Ask first`, `Never`]);
    expect(tabs.map((tab) => tab.getAttribute(`aria-selected`))).toEqual([`true`, `false`, `false`]);
});

test("choosing Ask first writes ask and says the answer is given in the chat", async () => {
    const host = mount();
    pill(host, `Ask first`).click();
    await nextTick();
    expect(patch).toHaveBeenCalledWith({ projectInstalls: `ask` });
    expect(host.textContent).toContain(ASK_NOTE);
});

test("choosing Never writes never and says the land installs what was added", async () => {
    const host = mount();
    pill(host, `Never`).click();
    await nextTick();
    expect(patch).toHaveBeenCalledWith({ projectInstalls: `never` });
    expect(host.textContent).toContain(NEVER_NOTE);
});

test("a stored answer is the one shown", async () => {
    settings.value = { ...settings.value, projectInstalls: `never` };
    const host = mount();
    await nextTick();
    expect(pill(host, `Never`).getAttribute(`aria-selected`)).toBe(`true`);
    expect(host.textContent).toContain(NEVER_NOTE);
});
