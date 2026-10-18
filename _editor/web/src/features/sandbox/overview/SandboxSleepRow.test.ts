// Pins who sees the sleep switch, what it says either way, and that flipping it writes `sleepWhenUnused` alone.
// jsdom: mounts the row and reads rendered DOM.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";

// A sandbox row: `hosted` present means Intentic runs the machine, whose idle stop is the plan's and not this switch's.
const active = ref<{ hosted: { region: string } | null } | undefined>({ hosted: null });
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
const canShip = ref(true);
jest.mock(`../../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip }) }));
// The schema's defaults with the one field this row reads; undefined is a daemon whose settings predate it.
const defaults = SandboxSettingsSchema.parse({});
const sleepWhenUnused = ref<boolean | undefined>(true);
const patch = jest.fn<(fields: Partial<SandboxSettings>) => void>();
jest.mock(`../../../models/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({
        settings: computed(() => ({ ...defaults, sleepWhenUnused: sleepWhenUnused.value })),
        patch,
        refusal: ref(undefined),
        save: { isPending: ref(false) },
    }),
}));

const { default: SandboxSleepRow } = await import("./SandboxSleepRow.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`dl`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxSleepRow) });
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    await nextTick();
    return el;
};
const toggle = (el: HTMLElement): HTMLInputElement | null => el.querySelector<HTMLInputElement>(`input[type="checkbox"]`);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    active.value = { hosted: null };
    canShip.value = true;
    sleepWhenUnused.value = true;
    patch.mockClear();
});

test("a sandbox on its owner's machine says it sleeps, and flipping the switch keeps it running", async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Sleep when unused`);
    expect(el.textContent).toContain(`runs late, once it wakes`);
    expect(toggle(el)?.checked).toBe(true);
    toggle(el)?.click();
    expect(patch).toHaveBeenCalledWith({ sleepWhenUnused: false });
});

test("switched off, it says schedules fire on time", async () => {
    sleepWhenUnused.value = false;
    const el = await mount();
    expect(el.textContent).toContain(`schedules fire on time`);
    expect(toggle(el)?.checked).toBe(false);
});

test("a hosted sandbox, or a daemon that does not know the setting, draws no row", async () => {
    active.value = { hosted: { region: `fra` } };
    expect((await mount()).textContent).toBe(``);
    app?.unmount();
    active.value = { hosted: null };
    sleepWhenUnused.value = undefined;
    expect((await mount()).textContent).toBe(``);
});

test("a member below maintainer reads it without being able to flip it", async () => {
    canShip.value = false;
    const el = await mount();
    expect(toggle(el)?.disabled).toBe(true);
});
