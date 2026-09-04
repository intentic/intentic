// @vitest-environment jsdom
//
// THE SWITCH OVER THE SAFETY JUDGE, and the model it runs on. Two settings that did not exist while the judge
// did, which left the one tier of the safety design that spends money and interrupts people with no controls at
// all: an owner whose gate asked about the wrong things could edit prose and hope, and nothing else.
//
// What is under test is the round trip a person performs on the group — read the state, move the switch, add a
// model, take it out — because each of those happens in the component's own handler, and because a control that
// drew a value it did not write is the worst version of a safety setting there is.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Two connected accounts, so the empty-list row has a real chain to name: what this row must say while nothing
// is pinned is WHICH account the verdicts are billed to, not the word "Auto".
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../composables/chat/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

// The picker is the app's whole model catalog behind one panel; what these tests are about is the wiring
// between the row and the list it writes, so it is stubbed down to "which entry was it opened over, and where
// does its answer land".
let opened: { readonly pin?: unknown; readonly taken?: unknown } | undefined;
let answer: { pick: (pin: unknown) => void } | undefined;
vi.mock(`./ModelPinPicker.vue`, () => ({
    __esModule: true,
    default: defineComponent({
        props: { open: Boolean, anchor: Object, pin: Object, knobs: Boolean, taken: Array },
        emits: [`update:open`, `pick`, `configure`],
        setup(props, { emit }) {
            opened = props;
            answer = { pick: (pin) => emit(`pick`, pin) };
            return () => h(`div`, { class: `pin-picker` });
        },
    }),
}));

const { default: AgentSafetyJudge } = await import("./AgentSafetyJudge.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyJudge) });
    app.use(PrimeVue);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    connected.value = [`codex`, `claude`];
    opened = undefined;
    answer = undefined;
    patch.mockClear();
});

const pill = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`button, [role="radio"], [role="tab"]`)].find((element) => element.textContent?.trim() === label)!;

const rowButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

const orderOnScreen = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

// The default, read off the schema rather than transcribed: a workspace nobody has configured judges commands,
// which is what every other part of this design assumes.
test("opens on the setting's own default", () => {
    const host = mount();
    expect(SandboxSettingsSchema.parse({}).commandJudge).toBe(`on`);
    expect(host.textContent).toContain(`The verdict decides`);
});

test("moving the switch writes the mode and says what that mode does", async () => {
    const host = mount();
    pill(host, `Watch`).click();
    await nextTick();
    expect(patch).toHaveBeenCalledWith({ commandJudge: `watch` });
    expect(host.textContent).toContain(`nothing is ever held`);
});

/* THE PROMISE THE SWITCH MAY NOT BREAK. "Off" reads as switching the gate off entirely, which it is not: the
 * hard rule is typed rather than judged and no setting reaches it. If that stops being said on the same screen
 * as the switch, the Safety page is making a promise the settings quietly contradict. */
test("the states that stop holding commands say what still asks", async () => {
    const host = mount();
    expect(host.textContent).not.toContain(`still asks`);

    for (const mode of [`Off`, `Watch`]) {
        pill(host, mode).click();
        await nextTick();
        expect(host.textContent, mode).toContain(`still asks`);
        expect(host.textContent, mode).toContain(`/history`);
    }
});

// While the list is empty the verdicts run on the sandbox's quick chain, and the row names it in full: which
// account a card is billed to is the fact this row exists to make readable.
test("names the quick chain in order while no judge model is pinned", () => {
    const host = mount();
    expect(settings.value.commandJudgeModels).toEqual([]);
    expect(host.textContent).toContain(`Your quick model`);
    expect(host.textContent).toContain(`Claude Haiku 4.5`);
    expect(host.textContent).toContain(`GPT 5.6 Luna`);
    expect(orderOnScreen(host)).toEqual([]);
});

test("a pinned model is drawn as the list and written back to its own setting", async () => {
    settings.value = { ...settings.value, commandJudgeModels: [`codex:gpt-5.6`] };
    const host = mount();
    await nextTick();
    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`]);

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();
    await nextTick();
    // Its own key, never the quick model's: the two lists are separate settings and emptying one is how it gets
    // back to the other.
    expect(patch).toHaveBeenCalledWith({ commandJudgeModels: [] });
});

test("adding a model appends it to the order, and the picker knows what is already taken", async () => {
    settings.value = { ...settings.value, commandJudgeModels: [`codex:gpt-5.6`] };
    const host = mount();
    await nextTick();

    rowButton(host, `Add a model for the safety judge`).click();
    await nextTick();
    expect(opened?.taken).toEqual([`codex:gpt-5.6`]);

    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(patch).toHaveBeenCalledWith({ commandJudgeModels: [`codex:gpt-5.6`, `claude:claude-haiku-4-5`] });
});

// Nothing to point a model at: the row that adds one goes inert rather than staying live and writing a setting
// with no reader.
test("the add control is disabled while the judge is off", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = mount();
    await nextTick();
    expect(rowButton(host, `Add a model for the safety judge`).disabled).toBe(true);
});
