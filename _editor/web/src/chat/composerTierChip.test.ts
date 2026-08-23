// @vitest-environment jsdom
//
/* THE CHIP AS A PERSON MEETS IT: what it says, and whether pressing it does anything. Mounted rather than
 * projected, because the claim under test is the one the preview composable cannot make on its own, that a
 * state with no consequence draws no button. Measure mode is the case that matters: a chip that looked
 * pressable and moved nothing would teach people that this control lies, which is the exact failure the whole
 * awareness change exists to undo. */
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

test("measuring draws a label and nothing to press, because nothing is going to happen", () => {
    const host = mount(chatWith());

    expect(host.textContent).toContain(`Looks simple`);
    expect(host.querySelector(`button`)).toBeNull();
});

test("switched on, it names the model the turn will run and one press keeps the pick instead", async () => {
    settings.value = { ...settings.value, autoTier: `on` };
    const host = mount(chatWith());

    expect(host.textContent).toContain(`Cheaper: claude-haiku-4-5`);
    host.querySelector(`button`)!.click();
    await nextTick();

    expect(setTierHold).toHaveBeenCalledWith(true);
});

test("a standing hold reads as held and the same press lifts it again", async () => {
    settings.value = { ...settings.value, autoTier: `on` };
    const host = mount(chatWith({ tierHold: ref(true) }));

    expect(host.textContent).toContain(`My pick`);
    host.querySelector(`button`)!.click();
    await nextTick();

    expect(setTierHold).toHaveBeenCalledWith(false);
});

test("an empty composer and a hard-looking draft both draw nothing at all", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(mount(chatWith({ draft: ref(``) })).textContent).toBe(``);
    app?.unmount();
    document.body.innerHTML = ``;
    expect(mount(chatWith({ draft: ref(`refactor the planner across every provider arm`) })).textContent).toBe(``);
});
