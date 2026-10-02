// The push switch has to come to rest where the device actually is. PrimeVue's ToggleSwitch keeps its own copy of a press
// and lets go of it only when its model changes, so an enable refused without `state` ever passing through `on` (a
// blocked permission, which the desktop app's WebView2 answers without asking anyone) held the switch on, disabled
// there for good. jsdom: mounts the page and presses the real switch.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, nextTick, ref } from "vue";
import type { PushState } from "../../push/usePushNotifications";

const state = ref<PushState>(`off`);
const busy = ref(false);
// The composable's own gate, as far as this page reads it.
const canToggle = computed(() => (state.value === `off` || state.value === `on`) && !busy.value);

// Holds the chain open until a test answers it, the way a permission prompt does, then lands where the answer says.
let answer: (next: PushState) => void = () => undefined;
const chain = (): Promise<void> => {
    busy.value = true;
    return new Promise<void>((resolve) => {
        answer = (next) => {
            state.value = next;
            busy.value = false;
            resolve();
        };
    });
};
const enable = jest.fn(chain);
const disable = jest.fn(chain);

jest.mock(`../../push/usePushNotifications`, () => ({
    usePushNotifications: () => ({
        state,
        busy,
        error: ref(undefined),
        delivered: ref(undefined),
        canToggle,
        enable,
        disable,
        sendTest: jest.fn(),
    }),
}));
// Reaches the agents fleet at import, which this page never reads; only its test notice is pressed from here.
jest.mock(`../../shell/browser-tab/desktopSignal`, () => ({ sendTestNotice: jest.fn() }));

const { default: SettingsNotifications } = await import(`./SettingsNotifications.vue`);

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(SettingsNotifications);
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    state.value = `off`;
    busy.value = false;
    jest.clearAllMocks();
});

// The switch on the row that carries `title`: the innermost block holding both is the row's own line.
const switchBeside = (el: HTMLElement, title: string): HTMLInputElement => {
    const holders = [...el.querySelectorAll<HTMLElement>(`div`)].filter(
        (node) => (node.textContent ?? ``).includes(title) && node.querySelector(`input[role="switch"]`) !== null,
    );
    return holders.at(-1)!.querySelector<HTMLInputElement>(`input[role="switch"]`)!;
};

const NOTIFY = `Notify this device`;

test(`a refused enable lets the switch go, rather than holding it on over a device that never registered`, async () => {
    const el = mount();
    const toggle = switchBeside(el, NOTIFY);
    expect(toggle.checked).toBe(false);

    toggle.click();
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    await nextTick();
    // While the chain runs, the switch says where the press is taking it, and cannot be pressed again.
    expect(toggle.getAttribute(`aria-checked`)).toBe(`true`);
    expect(toggle.disabled).toBe(true);

    answer(`denied`);
    await waitFor(() => expect(toggle.getAttribute(`aria-checked`)).toBe(`false`));
    expect(toggle.checked).toBe(false);
    expect(el.textContent).not.toContain(`Send a test`);
});

test(`an enable that lands leaves the switch on and offers the test`, async () => {
    const el = mount();
    const toggle = switchBeside(el, NOTIFY);

    toggle.click();
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    answer(`on`);

    await waitFor(() => expect(el.textContent).toContain(`Send a test`));
    expect(toggle.getAttribute(`aria-checked`)).toBe(`true`);
    expect(toggle.disabled).toBe(false);
});

test(`a turn-off that does not go through puts the switch back on`, async () => {
    state.value = `on`;
    const el = mount();
    const toggle = switchBeside(el, NOTIFY);
    expect(toggle.checked).toBe(true);

    toggle.click();
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    // The daemon kept the registration: still on, whatever the press said.
    answer(`on`);

    await waitFor(() => expect(toggle.getAttribute(`aria-checked`)).toBe(`true`));
    expect(toggle.checked).toBe(true);
});
