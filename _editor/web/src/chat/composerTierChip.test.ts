// @vitest-environment jsdom
//
/* THE CHIP AS A PERSON MEETS IT: whether it is there at all, what it says, and what pressing it does. Mounted
 * rather than projected, because the claims under test are the ones the preview composable cannot make on its
 * own — that the default mode draws NOTHING on the composer, and that the state it does draw names its own
 * press. Both are the fix for the same complaint: a label appeared beside the model, meant something the UI
 * never said, and could only be explained by a hover title that a touch screen and a keyboard never see. */
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
vi.mock(`../composables/sandbox/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));
vi.mock(`../composables/chat/providerCatalog`, () => ({
    providerModels: ref({ claude: [{ value: `claude-opus-5` }, { value: `claude-haiku-4-5` }] }),
    modelLabelFor: (_provider: string, model: string) => model,
}));

const { default: ComposerTierChip } = await import("./ComposerTierChip.vue");

const setTierHold = vi.fn();
// Only what the chip and its preview read; a real Conversation drags a transcript and a live stream behind it.
const chatWith = (over: Record<string, unknown> = {}) => ({
    draft: ref(`what is a closure?`),
    attachments: ref([]),
    modePick: ref(`default`),
    lastTier: ref(undefined),
    provider: ref(`claude`),
    model: ref(`claude-opus-5`),
    tierHold: ref(false),
    setTierHold,
    ...over,
});

let app: App | undefined;
const mount = (conversation: ReturnType<typeof chatWith>): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(ComposerTierChip, { conversation: conversation as never }) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    setTierHold.mockClear();
});

test("the default mode draws nothing, because nothing is going to happen to the turn", () => {
    /* Measure is the shipped default, so this was the state most people were in, and it spent a slot on the
     * composer's model row saying "Looks simple" about a turn that would then run exactly the model they
     * picked. A control that reports a non-event teaches people to stop reading the row it sits in. */
    expect(settings.value.autoTier).toBe(`shadow`);

    expect(mount(chatWith()).textContent).toBe(``);
});

test("a swap about to happen names the model it lands on, and one press keeps the pick instead", async () => {
    settings.value = { ...settings.value, autoTier: `on` };
    const host = mount(chatWith());

    // Beside a pill reading "claude-opus-5": the chip is the arrow and the model that replaces it.
    expect(host.textContent).toContain(`claude-haiku-4-5`);
    host.querySelector(`button`)!.click();
    await nextTick();

    expect(setTierHold).toHaveBeenCalledWith(true);
});

test("a hold says which model it kept AND what the press does, rather than leaving that to a tooltip", async () => {
    settings.value = { ...settings.value, autoTier: `on` };
    const host = mount(chatWith({ tierHold: ref(true) }));

    expect(host.textContent).toContain(`Kept on claude-opus-5`);
    expect(host.textContent).toContain(`Undo`);
    host.querySelector(`button`)!.click();
    await nextTick();

    expect(setTierHold).toHaveBeenCalledWith(false);
});

test("both states are a real button carrying the whole sentence, for a reader with no pointer", () => {
    // `title` alone is a mouse-only affordance: no touch screen shows it and no screen reader announces it.
    settings.value = { ...settings.value, autoTier: `on` };
    const routing = mount(chatWith()).querySelector(`button`)!;

    expect(routing.getAttribute(`aria-label`)).toContain(`runs on claude-haiku-4-5 instead of claude-opus-5`);
    expect(routing.getAttribute(`aria-label`)).toContain(`Press to keep claude-opus-5`);

    app?.unmount();
    document.body.innerHTML = ``;
    const holding = mount(chatWith({ tierHold: ref(true) })).querySelector(`button`)!;

    expect(holding.getAttribute(`aria-label`)).toContain(`kept on claude-opus-5`);
    expect(holding.getAttribute(`aria-label`)).toContain(`run on claude-haiku-4-5 again`);
});

test("a narrow pane costs the chip its words, never its mark", () => {
    /* The one control on that row announcing that the chosen model is about to be substituted. Hiding it whole
     * on a split pane or a phone would make the substitution silent on exactly the layouts where the model row
     * is hardest to read, so only the label folds away and the icon (plus its hover text) carries the state. */
    settings.value = { ...settings.value, autoTier: `on` };
    const host = mount(chatWith());

    const control = host.querySelector(`button`)!;
    expect(control.className).not.toContain(`hidden`);
    expect(control.querySelector(`span`)!.className).toContain(`@max-lg:hidden`);
    expect(control.getAttribute(`title`)).toContain(`claude-haiku-4-5`);
});

test("an empty composer and a hard-looking draft both draw nothing at all", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(mount(chatWith({ draft: ref(``) })).textContent).toBe(``);
    app?.unmount();
    document.body.innerHTML = ``;
    expect(mount(chatWith({ draft: ref(`refactor the planner across every provider arm`) })).textContent).toBe(``);
});
