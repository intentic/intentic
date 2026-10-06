// Pins what the custom system prompt tells its owner about a save (it landed, it was refused and why), and that starting
// from a built-in prompt never replaces text somebody wrote without asking. Mounted, since what's tested is what this
// page hands the document and what it does with a press.
import "@intentic/testing/dom";
import { SYSTEM_PROMPT_MAX, type BuiltinPromptText, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import * as uiOriginal from "@intentic/ui";
import * as actualSandboxRpc from "../../../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({ systemPromptMode: `custom`, systemPrompt: `Be brief.` }));
const saveError = ref<Error | null>(null);
const patch = jest.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

jest.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({
        settings,
        patch,
        dropped: ref(undefined),
        error: ref(undefined),
        isLoading: ref(false),
        // What the composable makes of a refused save, in its own words: this page only places it.
        refusal: computed(() => (saveError.value === null ? undefined : noticeFrom(saveError.value, t(`sandbox.useSandboxSettings.couldntSave`)))),
        save: { mutate: patch, isPending: ref(false), error: saveError },
    }),
}));
jest.mock(`../../usage/useSavings`, () => ({ useSavings: () => ({ savings: ref(undefined) }) }));

const builtinPrompt = jest.fn<(input: ProcedureInput<`settings.builtinPrompt`>) => Promise<BuiltinPromptText>>(async () => ({
    text: `You are Intentic's agent.`,
    version: `2.1.0`,
}));
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ settings: { builtinPrompt } }) }));

// The document surface is `@intentic/ui`'s own and has its own suite; what is under test is what this page hands it.
let doc: { readonly modelValue?: string; readonly stored?: string; readonly maxChars?: number } | undefined;
let saveDoc: ((text: string) => void) | undefined;
// A keystroke in the document, as the page's v-model hears it.
let typed: ((text: string) => void) | undefined;
jest.mock(`@intentic/ui`, () => ({
    ...uiOriginal,
    MarkdownDocument: defineComponent({
        props: { modelValue: String, stored: String, maxChars: Number, placeholder: String, label: String, editable: Boolean, saving: Boolean },
        emits: [`update:modelValue`, `save`],
        setup(props, { emit }) {
            doc = props;
            saveDoc = (text: string) => emit(`save`, text);
            typed = (text: string) => emit(`update:modelValue`, text);
            return () => h(`div`, { class: `prompt-doc` });
        },
    }),
}));

const { default: AgentInstructions } = await import("./AgentInstructions.vue");

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentInstructions) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

const typeInto = async (text: string): Promise<void> => {
    typed?.(text);
    await nextTick();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({ systemPromptMode: `custom`, systemPrompt: `Be brief.` });
    saveError.value = null;
    doc = undefined;
    saveDoc = undefined;
    typed = undefined;
    patch.mockClear();
    builtinPrompt.mockClear();
});

const pressText = (label: string): void => {
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === label)!.click();
};

test("the cap the document draws is the one the schema refuses past", async () => {
    await mount();

    expect(doc?.maxChars).toBe(SYSTEM_PROMPT_MAX);
    expect(SandboxSettingsSchema.safeParse({ systemPrompt: `x`.repeat(SYSTEM_PROMPT_MAX) }).success).toBe(true);
    expect(SandboxSettingsSchema.safeParse({ systemPrompt: `x`.repeat(SYSTEM_PROMPT_MAX + 1) }).success).toBe(false);
});

test("a save that landed leaves nothing unsaved, although the editor's text ends in a blank line the save trimmed", async () => {
    await mount();
    await typeInto(`Be brief. Cite files.\n\n`);
    expect(doc?.stored).toBe(`Be brief.`);

    saveDoc?.(`Be brief. Cite files.\n\n`);
    await nextTick();

    expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({ systemPrompt: `Be brief. Cite files.` }));
    // What the document measures "unsaved" against now reads as its own text: Save rests and the status says Saved.
    expect(doc?.stored).toBe(`Be brief. Cite files.\n\n`);
    expect(doc?.modelValue).toBe(`Be brief. Cite files.\n\n`);
});

test("a refused save says why under the document", async () => {
    const host = await mount();
    expect(host.textContent).not.toContain(`Couldn't save`);

    saveError.value = new Error(`systemPrompt: Too big: expected string to have <=20000 characters`);
    await nextTick();

    expect(host.textContent).toContain(`Couldn't save your change`);
    expect(host.textContent).toContain(`Too big: expected string to have <=20000 characters`);
});

test("starting from Intentic's prompt asks before replacing text already written, and keeps it on Cancel", async () => {
    await mount();
    await typeInto(`My own long doctrine.`);

    pressText(`Start from Intentic's`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(doc?.modelValue).toBe(`My own long doctrine.`);
    expect(document.body.textContent).toContain(`Replace your text?`);

    pressText(`Cancel`);
    await nextTick();
    expect(doc?.modelValue).toBe(`My own long doctrine.`);

    pressText(`Start from Intentic's`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    pressText(`Replace`);
    await nextTick();
    expect(doc?.modelValue).toBe(`You are Intentic's agent.`);
});

test("starting from Intentic's prompt on an empty document asks nothing", async () => {
    settings.value = { ...settings.value, systemPrompt: `` };
    await mount();

    pressText(`Start from Intentic's`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(document.body.textContent).not.toContain(`Replace your text?`);
    expect(doc?.modelValue).toBe(`You are Intentic's agent.`);
});
