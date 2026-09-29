// The row of documents a finished turn ends on: one chip per document, named with what kind it is, a press opening the
// file where the chat opens files, and a web page asked for rendered rather than as its source.
import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE, type ChatSurface } from "../../tools/chatToolSurface";
import { htmlPreviewed, setHtmlPreviewed } from "../../../workspace/viewers/html/htmlPreviewed";
import type { ChatDeliverable } from "./deliverables";
import ChatTurnDeliverables from "./ChatTurnDeliverables.vue";

let app: App | undefined;
const opened = jest.fn<(path: string, line?: number) => void>();

const mount = (deliverables: readonly ChatDeliverable[], surface: ChatSurface = { imageUrl: () => undefined, openFile: opened }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnDeliverables, { deliverables }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.provide(CHAT_SURFACE, surface);
    app.mount(element);
    return element;
};

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];

const made = (...paths: string[]): ChatDeliverable[] =>
    paths.map((path) => ({ path, kind: path.endsWith(`.pptx`) ? `pptx` : path.endsWith(`.html`) ? `html` : `pdf`, turnId: 1 }));

beforeEach(() => {
    opened.mockClear();
    setHtmlPreviewed(`site/index.html`, false);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`ChatTurnDeliverables`, () => {
    it(`names each document by its file and says what kind it is`, () => {
        const element = mount(made(`board/Q3 deck.pptx`, `board/minutes.pdf`));
        expect(buttons(element).map((button) => button.getAttribute(`aria-label`))).toEqual([`Open Q3 deck.pptx, Slide deck`, `Open minutes.pdf, PDF`]);
        expect(buttons(element).map((button) => [...button.querySelectorAll(`span span`)].map((line) => line.textContent))).toEqual([
            [`Q3 deck.pptx`, `Slide deck`],
            [`minutes.pdf`, `PDF`],
        ]);
    });

    it(`a press opens the document by its workspace path`, () => {
        buttons(mount(made(`board/minutes.pdf`)))[0]?.click();
        expect(opened.mock.calls).toEqual([[`board/minutes.pdf`]]);
        expect(htmlPreviewed(`board/minutes.pdf`)).toBe(false);
    });

    it(`a web page is asked for rendered before it opens`, () => {
        buttons(mount(made(`site/index.html`)))[0]?.click();
        expect(htmlPreviewed(`site/index.html`)).toBe(true);
        expect(opened.mock.calls).toEqual([[`site/index.html`]]);
    });

    it(`where nothing can be opened, the documents are still listed and nothing is pressable`, () => {
        const [chip] = buttons(mount(made(`deck.pptx`), { imageUrl: () => undefined }));
        expect(chip?.disabled).toBe(true);
        expect(chip?.textContent).toContain(`deck.pptx`);
    });
});
