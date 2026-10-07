// Pins that a pinned model's row keeps its element while its words change: the picker hangs off the row's button, and a
// row redrawn under it (keyed on its label, which moves when a provider's catalog lands) took the picker's anchor away,
// so the picker shut itself and the press that opened it read as doing nothing.
import "@intentic/testing/dom";
import type { ModelChoice, ModelPin } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// What each model is called, as the catalogs say it: before a provider's catalog lands its ids read humanized.
const labels = ref<Record<string, string>>({ "gemini:gemini-3.1-pro": `Gemini 3 1 Pro`, "claude:claude-haiku-4-5": `Claude Haiku 4.5` });
jest.mock(`../../../chat/models/modelPins`, () => ({
    describePin: (choice: ModelChoice | undefined, raw: string) =>
        choice === undefined
            ? { choice: undefined, label: raw, ready: false }
            : { choice, label: labels.value[`${choice.provider}:${choice.model}`] ?? raw, ready: true },
}));
jest.mock(`../../../chat/accounts/ProviderLogo.vue`, () => ({
    __esModule: true,
    default: defineComponent({ render: () => h(`span`) }),
}));

const { pinnedList } = await import("./modelPinList");
const { default: ModelPinList } = await import("./ModelPinList.vue");

const pin = (provider: string, model: string): ModelPin => ({ provider, model }) as ModelPin;

const listOf = (pins: readonly ModelPin[]) => {
    const stored = ref<readonly ModelPin[]>(pins);
    return pinnedList<ModelPin>({ read: () => stored.value, write: (next) => (stored.value = next), decode: (held) => held, encode: (held) => held });
};

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`a pinned model's row`, () => {
    it(`keeps its button while the model's name changes under it`, async () => {
        const list = listOf([pin(`gemini`, `gemini-3.1-pro`), pin(`claude`, `claude-haiku-4-5`)]);
        const host = document.createElement(`div`);
        document.body.append(host);
        app = createApp({ render: () => h(ModelPinList, { entries: list.entries.value }) });
        app.component(`Icon`, IconStub);
        // Drawn only for a model whose provider is not connected, which none here is.
        app.component(`RouterLink`, defineComponent({ render: () => h(`a`) }));
        app.directive(`tooltip`, {});
        app.mount(host);
        const before = host.querySelector(`li button`);

        // The catalog lands, and the row's words with it.
        labels.value = { ...labels.value, "gemini:gemini-3.1-pro": `Gemini 3.1 Pro` };
        await nextTick();

        const after = host.querySelector(`li button`);
        expect(after?.getAttribute(`aria-label`)).toBe(`Change Gemini 3.1 Pro`);
        expect(after).toBe(before);
    });

    it(`is keyed by the model it names, each of a repeated model apart`, () => {
        const list = listOf([pin(`gemini`, `gemini-3.1-pro`), pin(`claude`, `claude-haiku-4-5`), pin(`gemini`, `gemini-3.1-pro`)]);
        expect(list.entries.value.map((entry) => entry.key)).toEqual([`gemini:gemini-3.1-pro`, `claude:claude-haiku-4-5`, `gemini:gemini-3.1-pro#1`]);
    });
});
