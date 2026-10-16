// The row of documents a finished turn ends on: one chip per document, named with what kind it is, a press opening the
// file where the chat opens files, and a web page asked for rendered rather than as its source.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE, type ChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { htmlPreviewed, setHtmlPreviewed } from "../../../../models/workspace/viewers/htmlPreviewed";
import type { ChatDeliverable } from "./deliverables";

// The conversation's results as the daemon serves them (resultFiles.ts), so a press here is a call to read, not a fetch.
const read = jest.fn(async (_id: string, _path: string, _at?: string): Promise<Blob> => new Blob([`%PDF`], { type: `application/pdf` }));
const saved = jest.fn(async (_id: string, _path: string, _at?: string): Promise<void> => undefined);
jest.mock(`../../../../models/workspace/viewers/resultFiles`, () => ({ readResult: read, saveResult: saved }));
const { default: ChatTurnDeliverables } = await import(`./ChatTurnDeliverables.vue`);

let app: App | undefined;
const opened = jest.fn<(path: string, line?: number) => void>();

const mount = (deliverables: readonly ChatDeliverable[], surface: ChatSurface = { imageUrl: () => undefined, openFile: opened }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnDeliverables, { deliverables }) });
    // The document over the chat is a dialog, which needs PrimeVue's config.
    app.use(PrimeVue);
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
    read.mockClear();
    saved.mockClear();
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

    it(`where the chat reaches the conversation's results, each document downloads and prints too, and still opens in the viewer`, async () => {
        const element = mount(made(`board/minutes.pdf`), { imageUrl: () => undefined, openFile: opened, resultConversation: () => `c1`, resultBox: () => `box` });
        expect(buttons(element).map((button) => button.getAttribute(`aria-label`))).toEqual([`Open minutes.pdf, PDF`, `Download minutes.pdf`, `Print minutes.pdf`]);
        buttons(element)[0]?.click();
        expect(opened.mock.calls).toEqual([[`board/minutes.pdf`]]);
        buttons(element)[1]?.click();
        await Promise.resolve();
        expect(saved.mock.calls).toEqual([[`c1`, `board/minutes.pdf`, `box`]]);
    });

    it(`a reader with no Files to open it in (a guest) gets the document over the chat instead`, async () => {
        const element = mount(made(`board/minutes.pdf`), { imageUrl: () => undefined, openFile: opened, resultConversation: () => `c1`, resultsInPlace: () => true });
        buttons(element)[0]?.click();
        await Promise.resolve();
        expect(opened).not.toHaveBeenCalled();
        expect(read.mock.calls[0]?.slice(0, 2)).toEqual([`c1`, `board/minutes.pdf`]);
    });

    it(`a published page, which cannot reach the conversation, offers neither download nor print`, () => {
        const element = mount(made(`board/minutes.pdf`));
        expect(buttons(element)).toHaveLength(1);
    });
});
