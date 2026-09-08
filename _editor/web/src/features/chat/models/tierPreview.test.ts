import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { ref } from "vue";

// The judge itself is pinned in the contract; this file tests the three rules deciding whether the chip appears at
// all: a chip in a mode where nothing happens, one naming a model no cheaper than the pick, or one on a turn the
// daemon judges standard anyway.

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
vi.mock(`../../sandbox/overview/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));

// Haiku sits a rung below Opus; nothing here is cheaper than Haiku itself (the "already cheapest" case below).
vi.mock(`../accounts/providerCatalog`, () => ({
    providerModels: ref({ claude: [{ value: `claude-opus-5` }, { value: `claude-sonnet-5` }, { value: `claude-haiku-4-5` }] }),
    modelLabelFor: (_provider: string, model: string) => model,
}));

const { useTierPreview } = await import("./tierPreview");
type Chat = Parameters<typeof useTierPreview>[0] extends () => infer C ? C : never;

// Only the fields the preview reads; a real Conversation also carries a transcript, stream and registry.
const chatWith = (over: Partial<Record<string, unknown>> = {}): Chat =>
    ({
        attachments: ref([]),
        modePick: ref(`default`),
        lastTier: ref(undefined),
        provider: ref(`claude`),
        model: ref(`claude-opus-5`),
        tierHold: ref(false),
        ...over,
    }) as unknown as Chat;

const preview = (draft: string, chat: Chat = chatWith()) =>
    useTierPreview(
        () => chat,
        () => draft,
    ).value;

afterEach(() => {
    settings.value = SandboxSettingsSchema.parse({});
});

test("measuring previews nothing, because nothing is going to happen to the turn", () => {
    // Measure is the default (SandboxSettingsSchema); the mode judges and records without announcing anything on the
    // composer.
    expect(settings.value.autoTier).toBe(`shadow`);
    expect(preview(`what is a closure?`)).toBeUndefined();
});

test("switched on, it names both models: what the turn runs, and what it was going to", () => {
    // Both models are needed: each of the chip's two sentences names the other's model.
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`)).toEqual({ kind: `route`, cheap: `claude-haiku-4-5`, pick: `claude-opus-5` });
});

test("a standing hold reads as the veto it is, still naming what it declined", () => {
    // Naming the declined model makes the hold legible, not just "my pick".
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`, chatWith({ tierHold: ref(true) }))).toEqual({
        kind: `held`,
        cheap: `claude-haiku-4-5`,
        pick: `claude-opus-5`,
    });
});

test("nothing at all when the feature is off, when the box is empty, or when the draft looks like work", () => {
    settings.value = { ...settings.value, autoTier: `off` };
    expect(preview(`what is a closure?`)).toBeUndefined();

    settings.value = { ...settings.value, autoTier: `on` };
    expect(preview(`   `)).toBeUndefined();
    expect(preview(`refactor the planner across every provider arm`)).toBeUndefined();
});

test("a pick with nothing cheaper under it draws no chip, rather than a chip that promises nothing", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`, chatWith({ model: ref(`claude-haiku-4-5`) }))).toBeUndefined();
});

test("the last turn's verdict reaches the preview, so a deceptive follow-up is not promised cheap", () => {
    // The one judge input a draft cannot contain: a short follow-up can carry the whole weight of prior context.
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`list the exports`)).toEqual({ kind: `route`, cheap: `claude-haiku-4-5`, pick: `claude-opus-5` });
    expect(preview(`list the exports`, chatWith({ lastTier: ref(`standard`) }))).toBeUndefined();
});

test("plan mode is never previewed as cheap, matching the daemon's own gate", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`, chatWith({ modePick: ref(`plan`) }))).toBeUndefined();
});
