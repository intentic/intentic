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
const mount = (editable: boolean, source = `# Notes\n\nFirst line.`): HTMLElement => {
    // Where the viewer hangs its Source toggle: the breadcrumb's slot, there before the viewer is.
    const actions = document.createElement(`div`);
    actions.id = viewerActionsTarget(`main`);
    document.body.append(actions);
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(MarkdownViewer, { source, path: `notes.md`, editable }) });
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

// The section name in the breadcrumb is the outline's opener when the rail is not docked. It anchored the panel to the
// kit <Button>'s component instance rather than its element, so the panel had no document to open in and a press did
// nothing at all.
describe(`the current section, with the outline rail off`, () => {
    const LONG = `# One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.`;
    const realRect = Element.prototype.getBoundingClientRect;

    beforeEach(() => {
        // jsdom lays nothing out; a zero-size anchor closes its panel on purpose, so give everything a box.
        Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 20);
    });

    afterEach(() => {
        Element.prototype.getBoundingClientRect = realRect;
    });

    const outlines = (): number => document.querySelectorAll(`nav[aria-label="Document outline"]`).length;
    const actions = (): HTMLElement => document.querySelector<HTMLElement>(`#${viewerActionsTarget(`main`)}`)!;

    it(`opens the outline when pressed`, async () => {
        mount(false, LONG);
        await settle();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await settle();
        // The rail's preference is shared app state: whatever it was left at, turn it off.
        actions().querySelector<HTMLButtonElement>(`[aria-label="Hide outline"]`)?.click();
        await settle();
        expect(outlines()).toBe(0);

        // The one control there without a label of its own: it shows the section's name instead.
        const opener = actions().querySelector<HTMLButtonElement>(`button:not([aria-label])`);
        expect(opener?.textContent).toMatch(/One|Two|Three/u);
        opener?.click();
        await settle();
        await settle();
        expect(outlines()).toBe(1);
    });
});
