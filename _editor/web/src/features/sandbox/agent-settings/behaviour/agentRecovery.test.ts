// Pins the team-chat threads row: it opens on the daemon's own default, writes its own key and nothing else, and keeps
// to the bounds the save accepts, writing back the number it kept.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { storedValue, storeJson } from "@intentic/ui/storage";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, refusal: ref(undefined), dropped: ref(undefined), error: ref(undefined), isLoading: ref(false) }),
}));

// The threads and turn-cap rows are Advanced's; the section's choice is read once, as its module loads, so it is set
// before the import.
storeJson(`intentic:agent-tools-detail`, { "turn-breaks": `advanced` });
const { default: AgentRecovery } = await import("./AgentRecovery.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentRecovery) });
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

const threadsBox = (host: HTMLElement): HTMLInputElement =>
    host.querySelector<HTMLInputElement>(`input[aria-label="Threads of one team-chat automation worked on at once"]`)!;

const change = async (box: HTMLInputElement, value: string): Promise<void> => {
    box.value = value;
    box.dispatchEvent(new Event(`change`));
    await nextTick();
};

test("the threads row opens on the daemon's own default", () => {
    const host = mount();

    expect(threadsBox(host).value).toBe(String(SandboxSettingsSchema.parse({}).automationThreadsAtOnce));
});

test("the threads row writes its own key and nothing else", async () => {
    const host = mount();
    await change(threadsBox(host), `5`);

    expect(patch).toHaveBeenCalledWith({ automationThreadsAtOnce: 5 });
});

test("the threads row keeps to what the save accepts, and shows the number it kept", async () => {
    const host = mount();
    const box = threadsBox(host);
    await change(box, `50`);
    expect(patch).toHaveBeenLastCalledWith({ automationThreadsAtOnce: 20 });
    expect(box.value).toBe(`20`);

    await change(box, `0`);
    expect(patch).toHaveBeenLastCalledWith({ automationThreadsAtOnce: 1 });
    expect(box.value).toBe(`1`);
});

// The longest turn on a sandbox-driven loop: opens on the daemon's default, writes its own key, keeps to its bounds.
const capBox = (host: HTMLElement): HTMLInputElement => host.querySelector<HTMLInputElement>(`input[aria-label="Longest turn, in minutes"]`)!;

test("the turn cap row opens on the daemon's default, writes its own key, and keeps to what the save accepts", async () => {
    const host = mount();
    const box = capBox(host);
    expect(box.value).toBe(String(SandboxSettingsSchema.parse({}).turnCapMinutes));
    await change(box, `90`);
    expect(patch).toHaveBeenLastCalledWith({ turnCapMinutes: 90 });
    await change(box, `1`);
    expect(patch).toHaveBeenLastCalledWith({ turnCapMinutes: 5 });
    expect(box.value).toBe(`5`);
});

test("the keep-warm token threshold accepts values above ten million, as the daemon does", async () => {
    const warm = { ...settings.value.keepWarm, auto: true };
    settings.value = { ...settings.value, keepWarm: warm };
    const host = mount();
    const box = host.querySelector<HTMLInputElement>(`input[aria-label="Minimum context, in tokens"]`)!;

    expect(box.max).toBe(String(Number.MAX_SAFE_INTEGER));
    await change(box, `20000000`);

    expect(patch).toHaveBeenLastCalledWith({ keepWarm: { ...warm, minTokens: 20_000_000 } });
    expect(box.value).toBe(`20000000`);
});

// Simple keeps the one answer per ending and the restart switch; Advanced adds the hand-off, the turn cap and the
// automation ceilings, and the choice is kept for this section alone.
test("Simple keeps each ending's answer, and Advanced adds the tuning and the automation ceilings", async () => {
    const host = mount();
    const pick = (label: string): void =>
        [...host.querySelectorAll<HTMLElement>(`button`)].find((button) => button.textContent?.trim() === label)?.click();
    const marked = (id: string): boolean => host.querySelector(`[data-setting="${id}"]`) !== null;
    const advancedRows = [`agent-turn-handoff`, `agent-turn-cap`, `agent-failing-automation`, `agent-automation-threads`];

    pick(`Simple`);
    await nextTick();
    expect(advancedRows.filter(marked)).toEqual([]);
    expect(threadsBox(host)).toBeNull();
    expect(host.textContent).toContain(`Resume turns after a restart`);

    pick(`Advanced`);
    await nextTick();
    expect(advancedRows.filter((id) => !marked(id))).toEqual([]);
    expect(storedValue(`intentic:agent-tools-detail`)).toBe(JSON.stringify({ "turn-breaks": `advanced` }));
});
