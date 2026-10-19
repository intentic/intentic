// Pins what a reader can do with a review's card: open a finding's place, read its detail, and put a fix in the
// composer, each through the chat's surface, so a published conversation draws the findings with nothing to press.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import type { ReviewFindings } from "@intentic/sandbox-contract/events/review";
import type { ChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { IconStub } from "@intentic/ui/testing";

const { default: ChatReviewCard } = await import("./ChatReviewCard.vue");
const { CHAT_SURFACE } = await import("../../../../models/conversations/tools/chatToolSurface");

// path-literals: content, the files a review's findings name as the card shows them
const REVIEW: ReviewFindings = {
    id: `review-1`,
    source: `codex`,
    findings: [
        { file: `src/upload.ts`, line: 40, summary: `Retry drops the last chunk`, priority: 1, body: `The loop exits before the final flush.` },
        { file: `src/cache.ts`, line: 7, summary: `The cache never expires.` },
    ],
};

let app: App | undefined;
const mount = (review: ReviewFindings, surface?: ChatSurface): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatReviewCard, { review }) });
    if (surface !== undefined) {
        app.provide(CHAT_SURFACE, surface);
    }
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const buttons = (element: HTMLElement, text: string): HTMLButtonElement[] =>
    [...element.querySelectorAll(`button`)].filter((button) => button.textContent?.trim() === text);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`ChatReviewCard`, () => {
    it(`opens a finding's place in the conversation's copy, and its detail under it`, async () => {
        const opened: [string, number | undefined][] = [];
        const element = mount(REVIEW, { imageUrl: () => undefined, openFile: (path, line) => opened.push([path, line]) });
        buttons(element, `upload.ts:40`)[0]?.click();
        expect(opened).toEqual([[`src/upload.ts`, 40]]);
        expect(element.textContent).not.toContain(`The loop exits`);
        [...element.querySelectorAll(`button[aria-expanded]`)][0]?.dispatchEvent(new MouseEvent(`click`));
        await nextTick();
        expect(element.textContent).toContain(`The loop exits before the final flush.`);
    });

    it(`puts a fix for one finding, or for all of them, in the composer`, () => {
        const drafted: string[] = [];
        const element = mount(REVIEW, { imageUrl: () => undefined, draftMessage: (text) => drafted.push(text) });
        buttons(element, `Fix`)[1]?.click();
        buttons(element, `Fix all`)[0]?.click();
        expect(drafted).toEqual([
            `Fix this finding from the review above: src/cache.ts:7 — The cache never expires.`,
            `Fix these findings from the review above:\n1. src/upload.ts:40 — Retry drops the last chunk\n2. src/cache.ts:7 — The cache never expires.`,
        ]);
    });

    // A fresh session only saw the work: the agent that made it judges which findings hold, so Fix goes to its composer,
    // each finding with what makes it go wrong, since that conversation never saw this card.
    it(`puts a fresh session's fix in the original conversation's composer instead`, () => {
        const local: string[] = [];
        const original: string[] = [];
        const element = mount(REVIEW, {
            imageUrl: () => undefined,
            draftMessage: (text) => local.push(text),
            fixIn: () => ({ title: `Upload retries`, draft: (text) => original.push(text) }),
        });
        buttons(element, `Fix in the original`)[1]?.click();
        buttons(element, `Fix all in the original`)[0]?.click();
        expect(local).toEqual([]);
        expect(original).toHaveLength(2);
        expect(original[0]).toContain(`which saw your work but not this conversation`);
        expect(original[0]).toContain(`src/cache.ts:7 — The cache never expires.`);
        expect(original[1]).toContain(`1. src/upload.ts:40 — Retry drops the last chunk\n   The loop exits before the final flush.\n2. src/cache.ts:7`);
        expect(buttons(element, `Fix`)).toHaveLength(0);
    });

    it(`draws the findings with nothing to press where the surface offers nothing`, () => {
        const element = mount(REVIEW);
        expect(element.textContent).toContain(`Retry drops the last chunk`);
        expect(element.textContent).toContain(`src/upload.ts:40`);
        expect(buttons(element, `Fix`)).toHaveLength(0);
        expect(buttons(element, `Fix all`)).toHaveLength(0);
    });

    it(`folds a review re-reported further down to one line, and says a clean one found nothing`, async () => {
        const folded = mount({ ...REVIEW, superseded: true });
        expect(folded.textContent).toContain(`an earlier report, updated below`);
        expect(folded.textContent).not.toContain(`Retry drops`);
        app?.unmount();
        const clean = mount({ ...REVIEW, findings: [] });
        expect(clean.textContent).toContain(`No findings`);
    });
});
