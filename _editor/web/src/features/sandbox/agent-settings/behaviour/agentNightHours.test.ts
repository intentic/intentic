// Pins the night hours group: it stays one switch until the owner turns it on, writes the whole night object back with
// only the changed field moved, refuses a time that is not one, and says under the choice what that choice does.
import "@intentic/testing/dom";
import { NightHoursSchema } from "@intentic/sandbox-contract/schemas/night-hours";
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

const { default: AgentNightHours } = await import("./AgentNightHours.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentNightHours) });
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

const NIGHT_ON = { ...NightHoursSchema.parse({}), on: true };
const fromBox = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`input[aria-label="Night starts at"]`);
const toBox = (host: HTMLElement): HTMLInputElement => host.querySelector<HTMLInputElement>(`input[aria-label="Night ends at"]`)!;

const change = async (box: HTMLInputElement, value: string): Promise<void> => {
    box.value = value;
    box.dispatchEvent(new Event(`change`));
    await nextTick();
};

test("off until the owner sets it: one switch, and no hours to read", () => {
    const host = mount();

    expect(host.textContent).toContain(`Keep night hours`);
    expect(fromBox(host)).toBeNull();
});

test("on, it shows the night and its length, read on the sandbox's own clock", async () => {
    settings.value = { ...settings.value, nightHours: NIGHT_ON };
    const host = mount();
    await nextTick();

    expect(fromBox(host)?.value).toBe(`23:00`);
    expect(toBox(host).value).toBe(`07:00`);
    expect(host.textContent).toContain(`8 h a night`);
});

test("a changed time writes the whole night back with only that time moved", async () => {
    settings.value = { ...settings.value, nightHours: NIGHT_ON };
    const host = mount();
    await change(toBox(host), `06:30`);

    expect(patch).toHaveBeenCalledWith({ nightHours: { ...NIGHT_ON, to: `06:30` } });
    expect(host.textContent).toContain(`7 h 30 min a night`);
});

test("a cleared time writes nothing and shows the kept one again", async () => {
    settings.value = { ...settings.value, nightHours: NIGHT_ON };
    const host = mount();
    const box = toBox(host);
    await change(box, ``);

    expect(patch).not.toHaveBeenCalled();
    expect(box.value).toBe(`07:00`);
});

test("what a question gets is said under the choice, with what never gets answered for the owner", async () => {
    settings.value = { ...settings.value, nightHours: { ...NIGHT_ON, questions: `defer` } };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`then ends with the question`);
    expect(host.textContent).toContain(`Permissions, held commands and plans you asked to review still wait for you.`);
});
