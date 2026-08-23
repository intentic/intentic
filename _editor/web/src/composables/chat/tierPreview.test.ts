import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { ref } from "vue";

/* WHAT THE COMPOSER PROMISES BEFORE SEND. The judge itself is pinned in the contract; what this file is about
 * is the three rules that decide whether the chip appears at all, because each one is a way for an honest
 * mechanism to become noise: a chip in a mode where nothing happens, a chip naming a model that isn't cheaper
 * than the pick, and a chip on a turn the daemon will judge standard anyway. */

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
vi.mock(`../sandbox/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));

// The picker's catalog: what Auto is allowed to reach for. Haiku under Opus is a rung down; nothing here is
// cheaper than Haiku itself, which is the "already on the cheap rung" case below.
vi.mock(`./providerCatalog`, () => ({
    providerModels: ref({ claude: [{ value: `claude-opus-5` }, { value: `claude-sonnet-5` }, { value: `claude-haiku-4-5` }] }),
    modelLabelFor: (_provider: string, model: string) => model,
}));

const { useTierPreview } = await import("./tierPreview");
type Chat = Parameters<typeof useTierPreview>[0] extends () => infer C ? C : never;

// Only the fields the preview reads. A real Conversation drags a transcript, a stream and a registry behind it,
// and none of that is what decides whether a draft looks simple.
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

test("measuring says only that the turn looks simple, because that is all that will happen", () => {
    expect(preview(`what is a closure?`)).toEqual({ kind: `measure` });
});

test("switched on, it names the model the turn will actually run", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`)).toEqual({ kind: `route`, label: `claude-haiku-4-5` });
});

test("a standing hold reads as the veto it is, still naming what it declined", () => {
    // Naming the declined model is what makes the control legible: a hold that said only "my pick" would leave
    // the user unable to tell whether it was doing anything.
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`, chatWith({ tierHold: ref(true) }))).toEqual({ kind: `held`, label: `claude-haiku-4-5` });
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
    // The one judge input a draft cannot contain: "now do the same for the other file" is nine easy words
    // carrying the whole weight of the task before them.
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`list the exports`)).toEqual({ kind: `route`, label: `claude-haiku-4-5` });
    expect(preview(`list the exports`, chatWith({ lastTier: ref(`standard`) }))).toBeUndefined();
});

test("plan mode is never previewed as cheap, matching the daemon's own gate", () => {
    settings.value = { ...settings.value, autoTier: `on` };

    expect(preview(`what is a closure?`, chatWith({ modePick: ref(`plan`) }))).toBeUndefined();
});
