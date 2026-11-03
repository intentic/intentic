// Pins when the host GPU row is drawn, what it says, that its switch writes `gpu.shells`, and that resuming GPU work after
// a GPU reset clears `gpu.pausedFor` and nothing else. jsdom: mounts the row and reads rendered DOM.
import "@intentic/testing/dom";
import { type GpuSettings, GpuSettingsSchema, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";

const canShip = ref(true);
jest.mock(`../../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip }) }));
// The Docker capability as its echo lists it: `gpu` is the owner's ask, a boolean.
const dockerGpu = ref(true);
jest.mock(`../../../models/capabilities/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities: computed(() => [{ id: `docker`, kind: `docker`, config: { gpu: dockerGpu.value } }]) }),
}));
const defaults = SandboxSettingsSchema.parse({});
const gpu = ref<GpuSettings | undefined>(GpuSettingsSchema.parse({}));
const patch = jest.fn<(fields: Partial<SandboxSettings>) => void>();
jest.mock(`../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({
        settings: computed(() => ({ ...defaults, gpu: gpu.value })),
        patch,
        refusal: ref(undefined),
        save: { isPending: ref(false) },
    }),
}));

const { default: SandboxGpuRow } = await import("./SandboxGpuRow.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`dl`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxGpuRow) });
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    await nextTick();
    return el;
};
const toggle = (el: HTMLElement): HTMLInputElement | null => el.querySelector<HTMLInputElement>(`input[type="checkbox"]`);
const resume = (el: HTMLElement): HTMLButtonElement | undefined => [...el.querySelectorAll(`button`)].find((button) => button.textContent.includes(`Resume GPU work`));

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    canShip.value = true;
    dockerGpu.value = true;
    gpu.value = GpuSettingsSchema.parse({});
    patch.mockClear();
});

test("a sandbox asking for the GPU says agents use it on request, and the switch gives it to every command", async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Host GPU`);
    expect(el.textContent).toContain(`only for commands they run through gpu-run`);
    expect(toggle(el)?.checked).toBe(false);
    toggle(el)?.click();
    expect(patch).toHaveBeenCalledWith({ gpu: { shells: `all`, timeoutMinutes: 0 } });
});

test("GPU work paused after a GPU reset names the event, and resuming clears only the pause", async () => {
    gpu.value = { shells: `all`, timeoutMinutes: 30, pausedFor: `rog reported a GPU reset at 2026-11-02T19:30:52Z (LiveKernelEvent 141).` };
    const el = await mount();
    expect(el.textContent).toContain(`GPU work is paused: rog reported a GPU reset at 2026-11-02T19:30:52Z (LiveKernelEvent 141).`);
    resume(el)?.click();
    expect(patch).toHaveBeenCalledWith({ gpu: { shells: `all`, timeoutMinutes: 30 } });
});

test("no GPU asked for, or a daemon that does not know the setting, draws no row", async () => {
    dockerGpu.value = false;
    expect((await mount()).textContent).toBe(``);
    app?.unmount();
    dockerGpu.value = true;
    gpu.value = undefined;
    expect((await mount()).textContent).toBe(``);
});

// The words are the row: no switch and no resume for a member who cannot write settings.
test("a member below maintainer reads it without being able to change it", async () => {
    canShip.value = false;
    gpu.value = { shells: `on-request`, timeoutMinutes: 0, pausedFor: `a GPU reset` };
    const el = await mount();
    expect(toggle(el)).toBeNull();
    expect(resume(el)).toBeUndefined();
    expect(el.textContent).toContain(`GPU work is paused: a GPU reset`);
});
