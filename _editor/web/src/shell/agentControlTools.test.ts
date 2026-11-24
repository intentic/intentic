// What an agent's two control tools read and do, on the kit's real components. The point of them is that a step lands
// exactly as a press would: through the component's own model, so the parent's v-model sees the change. And that a
// name finds one control or says why it can't, rather than working whichever matched first.
import "@intentic/testing/dom";
import { armAgentControls, ConfirmDialog, DisclosureRow, Picker, SegmentedControl } from "@intentic/ui";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { actOnControls, readControls } from "./agentControlTools";

// Armed before anything mounts, as main.ts does in a dev build.
const registry = armAgentControls();

const mounted: { app: App; host: HTMLElement }[] = [];
afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
});

// jsdom lays nothing out, so no element has a box; a test gives one to each element it puts on screen.
const show = (element: Element): void => {
    Object.defineProperty(element, `getClientRects`, { value: () => [new DOMRect(0, 0, 10, 10)], configurable: true });
};

const mount = (render: () => ReturnType<typeof h>): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(host);
    mounted.push({ app, host });
    return host;
};

const showAll = (host: Element): void => {
    host.querySelectorAll(`*`).forEach(show);
};

const THEMES = [
    { value: `light`, label: `Light` },
    { value: `dark`, label: `Dark` },
    { value: `sanctum`, label: `Sanctum`, disabled: true },
];

it("lists a picker with its name, value and choices, and picks through its model", async () => {
    const theme = ref<string | undefined>(`light`);
    const host = mount(() => h(Picker, { options: THEMES, ariaLabel: `Theme`, modelValue: theme.value, "onUpdate:modelValue": (next: string | undefined) => (theme.value = next) }));
    await nextTick();
    showAll(host);

    const { controls } = readControls(registry, {});
    expect(controls).toEqual([
        {
            ref: expect.stringMatching(/^c\d+$/u),
            kind: `picker`,
            label: `Theme`,
            state: { value: `light`, chosen: `Light`, open: false, disabled: false },
            choices: [
                { value: `light`, label: `Light` },
                { value: `dark`, label: `Dark` },
                { value: `sanctum`, label: `Sanctum`, disabled: true },
            ],
            actions: { pick: `choice`, setOpen: `flag` },
        },
    ]);

    // By name and by a choice's words, case ignored.
    const result = await actOnControls(registry, { steps: [{ control: `theme`, action: `pick`, value: `dark` }] });
    expect(result.ok).toBe(true);
    expect(theme.value).toBe(`dark`);
    expect(result.steps[0]?.now).toMatchObject({ value: `dark`, chosen: `Dark` });
});

it("refuses a disabled choice, an unknown one and an unknown action in words", async () => {
    const theme = ref<string | undefined>(`light`);
    const host = mount(() => h(Picker, { options: THEMES, ariaLabel: `Theme`, modelValue: theme.value, "onUpdate:modelValue": (next: string | undefined) => (theme.value = next) }));
    await nextTick();
    showAll(host);

    const disabled = await actOnControls(registry, { steps: [{ control: `Theme`, action: `pick`, value: `Sanctum` }] });
    expect(disabled).toMatchObject({ ok: false, failed: { step: 0, error: `"Sanctum" can't be chosen here` } });
    const unknown = await actOnControls(registry, { steps: [{ control: `Theme`, action: `pick`, value: `Mauve` }] });
    expect(unknown.failed?.error).toContain(`no choice "Mauve"`);
    const action = await actOnControls(registry, { steps: [{ control: `Theme`, action: `select`, value: `dark` }] });
    expect(action.failed?.error).toBe(`picker "Theme" takes no select now; it takes pick, setOpen`);
    const flag = await actOnControls(registry, { steps: [{ control: `Theme`, action: `setOpen`, value: `yes` }] });
    expect(flag.failed?.error).toContain(`true or false`);
    expect(theme.value).toBe(`light`);
});

it("names an unlabelled control by its row's title, and finds a control by one of its choices", async () => {
    const view = ref(`preview`);
    const host = mount(() =>
        h(`div`, [
            h(`div`, { class: `row` }, [
                h(`span`, { "data-row-title": `` }, `Show files as`),
                h(SegmentedControl, {
                    options: [
                        { value: `preview`, label: `Preview` },
                        { value: `source`, label: `Source` },
                    ],
                    modelValue: view.value,
                    "onUpdate:modelValue": (next: string) => (view.value = next),
                }),
            ]),
        ]),
    );
    await nextTick();
    showAll(host);

    const { controls } = readControls(registry, { text: `source` });
    expect(controls).toMatchObject([{ kind: `segmented`, label: `Show files as`, state: { value: `preview` }, actions: { select: `choice` } }]);

    // Several steps in one call, in order: here the same strip twice, by its ref.
    const ref0 = controls[0]?.ref ?? ``;
    const result = await actOnControls(registry, {
        steps: [
            { control: ref0, action: `select`, value: `source` },
            { control: `show files as`, action: `select`, value: `Preview` },
        ],
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.now)).toEqual([
        { value: `source`, chosen: `Source` },
        { value: `preview`, chosen: `Preview` },
    ]);
});

it("refuses a name two controls share, naming both, and leaves the off-screen ones out unless asked", async () => {
    const open = ref(false);
    const row = (title: string): ReturnType<typeof h> =>
        h(DisclosureRow, { title, open: open.value, "onUpdate:open": (next: boolean) => (open.value = next) }, { below: () => h(`p`, `details`) });
    const host = mount(() => h(`div`, [row(`Build log`), row(`Deploy log`), h(`div`, { class: `hidden` }, [row(`Old log`)])]));
    await nextTick();
    for (const element of host.querySelectorAll(`*`)) {
        if (element.closest(`.hidden`) === null) {
            show(element);
        }
    }

    expect(readControls(registry, { kind: `disclosure` }).controls.map((control) => control.label)).toEqual([`Build log`, `Deploy log`]);
    expect(readControls(registry, { kind: `disclosure`, offScreen: true }).controls.map((control) => control.label)).toEqual([`Build log`, `Deploy log`, `Old log`]);

    const ambiguous = await actOnControls(registry, { steps: [{ control: `log`, action: `setOpen`, value: true }] });
    expect(ambiguous.failed?.error).toMatch(/^"log" names 2 controls: c\d+ \(disclosure "Build log"\), c\d+ \(disclosure "Deploy log"\); pass a ref$/u);

    const opened = await actOnControls(registry, { steps: [{ control: `Build log`, action: `setOpen`, value: true }] });
    expect(opened.ok).toBe(true);
    expect(open.value).toBe(true);
});

it("answers a confirm's dialog with its confirm and cancel, emitted as its buttons would", async () => {
    const answers: string[] = [];
    mount(() =>
        h(ConfirmDialog, {
            open: true,
            header: `Delete this session?`,
            confirmLabel: `Delete`,
            onConfirm: () => answers.push(`confirm`),
            onCancel: () => answers.push(`cancel`),
        }),
    );
    await nextTick();
    await nextTick();

    const [dialog] = readControls(registry, { kind: `dialog`, offScreen: true }).controls;
    expect(dialog).toMatchObject({ label: `Delete this session?`, state: { open: true, dismissable: true } });
    expect(Object.keys(dialog?.actions ?? {}).sort()).toEqual([`cancel`, `close`, `confirm`]);

    const result = await actOnControls(registry, { steps: [{ control: `Delete this session?`, action: `confirm` }] });
    expect(result.ok).toBe(true);
    expect(answers).toEqual([`confirm`]);
});

it("offers nothing on a dialog that is closed, so a confirm nobody sees can't be answered", async () => {
    const answers: string[] = [];
    mount(() => h(ConfirmDialog, { open: false, header: `Delete this session?`, confirmLabel: `Delete`, onConfirm: () => answers.push(`confirm`) }));
    await nextTick();

    const [dialog] = readControls(registry, { kind: `dialog`, offScreen: true }).controls;
    expect(dialog).toMatchObject({ state: { open: false }, actions: {} });
    const result = await actOnControls(registry, { steps: [{ control: `Delete this session?`, action: `confirm` }] });
    expect(result.failed?.error).toBe(`dialog "Delete this session?" takes no confirm now; it takes nothing`);
    expect(answers).toEqual([]);
});

it("waits for a choice the app applies late, and says so when the app never applies it", async () => {
    const language = ref(`en`);
    const host = mount(() =>
        h(Picker, {
            options: [
                { value: `en`, label: `English` },
                { value: `pl`, label: `Polski` },
                { value: `de`, label: `Deutsch` },
            ],
            ariaLabel: `Language`,
            modelValue: language.value,
            // Polski loads its words first; Deutsch is refused outright.
            "onUpdate:modelValue": (next: string | undefined) => {
                if (next === `pl`) {
                    setTimeout(() => (language.value = next), 120);
                }
            },
        }),
    );
    await nextTick();
    showAll(host);

    const late = await actOnControls(registry, { steps: [{ control: `Language`, action: `pick`, value: `pl` }] });
    expect(late.steps[0]).toMatchObject({ now: { value: `pl` } });
    expect(late.steps[0]).not.toHaveProperty(`landed`);

    const refused = await actOnControls(registry, { steps: [{ control: `Language`, action: `pick`, value: `Deutsch` }] });
    expect(refused.steps[0]).toMatchObject({ now: { value: `pl` }, landed: false });
});

it("says what is wrong with a malformed call rather than throwing zod's JSON", async () => {
    await expect(actOnControls(registry, { steps: [] })).rejects.toThrow(/steps/u);
    expect(() => readControls(registry, { kind: 3 })).toThrow(/kind/u);
});
