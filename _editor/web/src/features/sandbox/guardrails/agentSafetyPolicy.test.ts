// A refused save of the safety policy says why: the document keeps the owner's text as "Not saved yet", and without the
// reason beside it the press reads as having done nothing. Mounted, since the claim is what the page draws.
import "@intentic/testing/dom";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as uiOriginal from "@intentic/ui";

const saveError = ref<Error | null>(null);
const answered = ref(true);
const readError = ref<string | undefined>(undefined);
jest.mock(`../environment/useSafetyPolicy`, () => ({
    useSafetyPolicy: () => ({
        text: computed(() => `Ask before deleting anything.\n`),
        custom: computed(() => true),
        save: jest.fn(),
        isSaving: computed(() => false),
        saveError: computed(() => saveError.value),
        answered,
        error: readError,
    }),
}));

// The document surface is `@intentic/ui`'s own and has its own suite; this page only hands it the text.
jest.mock(`@intentic/ui`, () => ({
    ...uiOriginal,
    MarkdownDocument: defineComponent({
        props: { modelValue: String, editable: Boolean, stored: String },
        setup: (props) => () => h(`div`, { class: `policy-doc`, "data-editable": String(props.editable), "data-stored": props.stored ?? `none` }),
    }),
}));

const { default: AgentSafetyPolicy } = await import("./AgentSafetyPolicy.vue");

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    saveError.value = null;
    answered.value = true;
    readError.value = undefined;
});

const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyPolicy) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

test("a refused save says why under the policy, and nothing is said before one", async () => {
    const host = await mount();
    expect(host.textContent).not.toContain(`Couldn't save the policy`);

    saveError.value = new Error(`the sandbox refused the write: disk full`);
    await nextTick();

    expect(host.textContent).toContain(`Couldn't save the policy`);
    expect(host.textContent).toContain(`the sandbox refused the write: disk full`);
});

// Under a failing read the page drew an empty policy, editable, with Save: one press would have replaced the sandbox's
// real policy with nothing. Only the daemon's answer makes the document editable.
test("a policy read that failed is never offered as an empty document to edit and save", async () => {
    answered.value = false;
    readError.value = `the sandbox did not answer`;
    const host = await mount();
    const doc = host.querySelector(`.policy-doc`);
    expect(doc?.getAttribute(`data-editable`)).toBe(`false`);
    expect(doc?.getAttribute(`data-stored`)).toBe(`none`);
    expect(host.textContent).toContain(`the sandbox did not answer`);
});
