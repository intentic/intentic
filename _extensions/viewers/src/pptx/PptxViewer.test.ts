import { stubGlobal, waitFor } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Deck } from "./deck-model";

// The viewer's show: one slide at a time over the whole window, moved by a presenter's keys, ended by Escape. The deck's
// reading is stood in (its own tests are pptx/deck.test.ts): what is under test is which slides are drawn when.
const slideOf = (number: number) => ({ number, background: undefined, boxes: [], notes: [] });
const deck: Deck = { width: 1280, height: 720, slides: [slideOf(1), slideOf(2), slideOf(3)] };

jest.mock("@intentic/extension-ui", () => ({ Icon: defineComponent({ setup: () => () => null }) }));
jest.mock("../i18n.js", () => ({ t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key} ${JSON.stringify(values)}`) }));
// Loads at once, with no spinner and no stale mark: what the show does with a drawn deck is what is under test.
jest.mock("../load/useViewerLoad.js", () => ({
    useViewerLoad: () => ({
        loading: ref(false),
        error: ref(undefined),
        stale: ref(false),
        start: async (work: (isLatest: () => boolean) => Promise<void>) => {
            await work(() => true);
        },
    }),
}));
jest.mock("../zip/unzip", () => ({ unzipParts: async () => ({}) }));
jest.mock("./deck", () => ({ readDeck: () => deck }));
// The viewer fits its slides to the pane it measures; the test DOM has nothing to measure with, and needs nothing.
stubGlobal(
    `ResizeObserver`,
    class {
        observe(): void {}
        disconnect(): void {}
    },
);
// The strip scrolls back to the slide a show ended on, which the test DOM cannot do.
Element.prototype.scrollIntoView = (): void => undefined;
const { default: PptxViewer } = await import("../PptxViewer.vue");

let app: App | undefined;
let root: HTMLElement;

beforeEach(async () => {
    root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(PptxViewer, { blob: new Blob([`deck`]) }) });
    app.mount(root);
    await waitFor(() => {
        if (root.querySelectorAll(`figure`).length !== 3) {
            throw new Error(`the deck is not drawn yet`);
        }
    });
});

afterEach(() => {
    app?.unmount();
    root.remove();
});

const button = (label: string): HTMLButtonElement => {
    const found = [...root.querySelectorAll(`button`)].find((each) => each.textContent?.includes(label) === true || each.getAttribute(`aria-label`) === label);
    if (found === undefined) {
        throw new Error(`no ${label} button`);
    }
    return found;
};

const key = async (name: string): Promise<void> => {
    window.dispatchEvent(new KeyboardEvent(`keydown`, { key: name, cancelable: true }));
    await nextTick();
};

const shown = (): string | undefined => root.querySelector(`.pptx-show`)?.textContent ?? undefined;

it(`presents one slide at a time, moved forward and back by a presenter's keys, and ends on Escape`, async () => {
    expect(root.querySelector(`.pptx-show`)).toBeNull();
    button(`pptxViewer.present`).click();
    await nextTick();
    expect(root.querySelectorAll(`figure`)).toHaveLength(1);
    expect(shown()).toContain(`{"number":1,"count":3}`);

    await key(`ArrowRight`);
    await key(` `);
    expect(shown()).toContain(`{"number":3,"count":3}`);
    // The last slide is as far as forward goes.
    await key(`PageDown`);
    expect(shown()).toContain(`{"number":3,"count":3}`);
    await key(`ArrowLeft`);
    expect(shown()).toContain(`{"number":2,"count":3}`);
    await key(`Home`);
    expect(shown()).toContain(`{"number":1,"count":3}`);

    await key(`Escape`);
    expect(root.querySelector(`.pptx-show`)).toBeNull();
    expect(root.querySelectorAll(`figure`)).toHaveLength(3);
    // Keys after the show are the page's again.
    const late = new KeyboardEvent(`keydown`, { key: `ArrowRight`, cancelable: true });
    window.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false);
});

it(`moves with the show's own buttons, and ends with its close`, async () => {
    button(`pptxViewer.present`).click();
    await nextTick();
    button(`pptxViewer.presentNext`).click();
    await nextTick();
    expect(shown()).toContain(`{"number":2,"count":3}`);
    button(`pptxViewer.presentEnd`).click();
    await nextTick();
    expect(root.querySelector(`.pptx-show`)).toBeNull();
});
