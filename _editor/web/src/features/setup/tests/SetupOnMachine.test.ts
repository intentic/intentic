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

// What a Windows PC on the Intentic engine printed (2026-10-21), which the page used to show line for line.
const RUN = [
    `intentic: [claiming-code] redeeming the setup code…`,
    `intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…`,
    `error getting credentials - err: exec: "docker-credential-desktop.exe": executable file not found in $PATH, out: \`\``,
    `intentic: [starting-sandbox] starting sandbox…`,
    `intentic: [waiting-health] waiting for the sandbox daemon to come up…`,
];

it(`draws what the machine is doing as the setup's steps, with its output one press away`, async () => {
    const { el } = await mount({ busy: true, lines: RUN });
    const text = el.textContent ?? ``;
    expect(text).toContain(`Setting it up on omen`);
    expect(text).toContain(`Download the sandbox image`);
    expect(text).toContain(`Wait for it to come up`);
    // The running step says what ic says it is doing; the rest of the output stays behind "Show log".
    expect(text).toContain(`waiting for the sandbox daemon to come up…`);
    expect(text).not.toContain(`docker-credential-desktop`);
    expect(text).toContain(`Show log`);
    expect(el.querySelector(`button`)?.hasAttribute(`disabled`)).toBe(true);
});

it(`draws nothing under the button before a press`, async () => {
    const { el } = await mount();
    expect(el.textContent).not.toContain(`Show log`);
});
