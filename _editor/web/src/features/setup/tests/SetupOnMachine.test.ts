// The card's one button once the "Runs on" row picked a connected machine: it names that machine, sends the press only
// when pressed, and stands down while something else is already on its way to a machine for this row.
import "@intentic/testing/dom";
import { installI18n } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick } from "vue";
import type { MachineDoor } from "../../sandbox/live/sandboxDoors";

const { default: SetupOnMachine } = await import("../SetupOnMachine.vue");

const omen: MachineDoor = { relay: `intentic`, hostId: `omen`, machineKey: `omen`, machineLabel: `omen`, severs: false };

let app: App | undefined;
const mount = async (over: { locked?: boolean; lines?: string[]; busy?: boolean } = {}) => {
    const setUpOn = jest.fn(async () => {});
    const run = {
        busy: computed(() => over.busy ?? false),
        lines: computed(() => over.lines ?? []),
        failure: computed(() => undefined),
    };
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        // SAFETY: the component reads only `busy`, `lines` and `failure` of the run, which this stand-in holds.
        render: () => h(SetupOnMachine, { door: omen, machine: { run, setUpOn } as never, locked: over.locked ?? false }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    installI18n(app);
    app.mount(el);
    await nextTick();
    return { el, setUpOn };
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`is one button naming the machine picked, which sends the press only when pressed`, async () => {
    const { el, setUpOn } = await mount();
    const buttons = [...el.querySelectorAll(`button`)];
    expect(buttons.map((each) => each.textContent?.trim())).toEqual([`Set it up on omen`]);
    expect(setUpOn).not.toHaveBeenCalled();
    buttons[0]?.click();
    await nextTick();
    expect(setUpOn).toHaveBeenCalledTimes(1);
});

it(`stands down while something else is on its way to a machine for this row`, async () => {
    const { el } = await mount({ locked: true });
    expect(el.querySelector(`button`)?.hasAttribute(`disabled`)).toBe(true);
});

it(`shows what the machine prints while it runs`, async () => {
    const { el } = await mount({ busy: true, lines: [`pulling the sandbox image`] });
    expect(el.textContent).toContain(`pulling the sandbox image`);
    expect(el.querySelector(`button`)?.hasAttribute(`disabled`)).toBe(true);
});
