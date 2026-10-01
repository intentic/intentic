// The markdown surface mounted for real (jsdom), its source view's Monaco stood in for: whether a reader the host lets
// write the file can type into it. No switch decides that any more; a browser that never pressed the Edit switch, which
// is every member who joins after it went, is the case this is about.
import "@intentic/testing/dom";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Monaco is the editor's own business: the source view stands in as what it was handed.
jest.mock("../CodeView.vue", () => ({
    default: defineComponent({
        props: { editable: Boolean, code: String },
        setup: (props) => () => h(`section`, { class: `code-view`, "data-editable": String(props.editable) }, props.code),
    }),
}));

const { default: MarkdownViewer } = await import("../MarkdownViewer.vue");
const { viewerActionsTarget } = await import("../../files/viewerChrome");

let app: App | undefined;
const mount = (editable: boolean): HTMLElement => {
    // Where the viewer hangs its Source toggle: the breadcrumb's slot, there before the viewer is.
    const actions = document.createElement(`div`);
    actions.id = viewerActionsTarget(`main`);
    document.body.append(actions);
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(MarkdownViewer, { source: `# Notes\n\nFirst line.`, path: `notes.md`, editable }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

const toggleSource = async (): Promise<void> => {
    document.querySelector<HTMLButtonElement>(`#${viewerActionsTarget(`main`)} [aria-label="View source"]`)?.click();
    await settle();
};

beforeEach(() => {
    // A browser with nothing saved, as a newly joined member's is.
    localStorage.clear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`a reader the host lets write the file`, () => {
    it(`types into the document straight away`, async () => {
        const element = mount(true);
        await settle();
        expect(element.querySelector(`.md-editing`)?.getAttribute(`contenteditable`)).toBe(`true`);
    });

    it(`types into the source view too`, async () => {
        const element = mount(true);
        await settle();
        await toggleSource();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`true`);
    });
});

describe(`a reader the host does not let write the file`, () => {
    it(`reads the document, with no caret in it`, async () => {
        const element = mount(false);
        await settle();
        expect(element.querySelector(`.md-editing`)).toBeNull();
        expect(element.textContent).toContain(`First line.`);
    });

    it(`reads the source view`, async () => {
        const element = mount(false);
        await settle();
        await toggleSource();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`false`);
    });
});
