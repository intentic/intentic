// Pins the team-chat threads row: it opens on the daemon's own default, writes its own key and nothing else, and keeps
// to the bounds the save accepts, writing back the number it kept.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, refusal: ref(undefined), dropped: ref(undefined), error: ref(undefined), isLoading: ref(false) }),
}));

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
