// Pins what a reviewer of a changed document reads: the marks over the text, the verdict when the text did not move,
// and the reason when a version could not be rendered. The daemon call is stubbed at this view's own seam.
import "@intentic/testing/dom";
import type { DerivedDiff } from "@intentic/sandbox-contract/schemas/diff";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const answers = new Map<string, DerivedDiff | Error>();
const asked: string[] = [];
jest.mock("../derivedDiff", () => ({
    readDerivedDiff: (source: { path: string }) => {
        asked.push(source.path);
        const answer = answers.get(source.path);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? {});
    },
}));

const { default: DerivedDiffView } = await import("../DerivedDiffView.vue");

const side = (content: string, notes: string[] = []): DerivedDiff["after"] => ({
    present: true,
    content,
    deriver: `docx v1`,
    notes,
    truncated: false,
});

let app: App | undefined;
const sidesRequested: number[] = [];
const mount = (path: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(DerivedDiffView, {
                path,
                source: { source: `working`, repo: `root`, side: `unstaged`, path },
                onSides: () => sidesRequested.push(1),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// The stubbed call resolves on the microtask queue; the ticks let the render that follows it land.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

beforeEach(() => {
    answers.clear();
    asked.length = 0;
    sidesRequested.length = 0;
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`DerivedDiffView`, () => {
    it(`opens on the tracked changes themselves, with no bar of its own over them`, async () => {
        answers.set(`brief.docx`, {
            before: side(`# Brief\n\nWe open at nine.\n\nClosed Monday.`),
            after: side(`# Brief\n\nWe open at eight.\n\nClosed Monday.`),
        });
        const element = mount(`brief.docx`);
        await settle();

        expect(asked).toEqual([`brief.docx`]);
        expect(element.querySelector(`del`)?.textContent).toBe(`nine`);
        expect(element.querySelector(`ins`)?.textContent).toBe(`eight`);
        // What the diff bar's Text reading already says (and which reader made the text) is not said again here, and
        // the way to Before / After is that bar's switch, not a second button under it.
        expect(element.textContent).not.toContain(`docx v1`);
        expect(element.textContent).not.toContain(`not shown`);
        expect([...element.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Before / After`))).toBe(false);
        expect(element.textContent).not.toContain(`from the conversion`);
    });

    it(`folds the conversions' caveats to a count, and opens them tagged with the side that hit each`, async () => {
        answers.set(`styled.docx`, {
            before: side(`Hello.`, [
                `docx conversion: a picture was left out`,
                `docx conversion: 3 Word styles without a markdown equivalent, read as plain text`,
            ]),
            after: side(`Hello there.`, [
                `docx conversion: a picture was left out`,
                `docx conversion: 2 Word styles without a markdown equivalent, read as plain text`,
            ]),
        });
        const element = mount(`styled.docx`);
        await settle();

        // The text comes first: the caveats are one line until asked for, and a caveat both sides share is one line.
        expect(element.textContent).toContain(`3 notes from the conversion`);
        expect(element.textContent).not.toContain(`a picture was left out`);
        const fold = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`from the conversion`));
        fold?.click();
        await nextTick();
        const items = [...element.querySelectorAll(`li`)].map((item) => [...item.querySelectorAll(`span`)].map((span) => span.textContent?.trim()));
        expect(items).toEqual([
            [`docx conversion: a picture was left out`],
            [`before`, `docx conversion: 3 Word styles without a markdown equivalent, read as plain text`],
            [`after`, `docx conversion: 2 Word styles without a markdown equivalent, read as plain text`],
        ]);
    });

    it(`says outright when both versions read the same, instead of showing no marks`, async () => {
        answers.set(`same.docx`, { before: side(`Hello.`), after: side(`Hello.`) });
        const element = mount(`same.docx`);
        await settle();

        // Once, as the document's first line, not as a strip over it and again in the body.
        expect(element.textContent?.split(`The text is the same in both versions`)).toHaveLength(2);
        expect(element.querySelectorAll(`ins, del`)).toHaveLength(0);
    });

    it(`says it over a spreadsheet's grid too, which has no first line to say it in`, async () => {
        answers.set(`same.xlsx`, { before: side(`## Sheet1\n\n| a |\n| --- |\n| 1 |`), after: side(`## Sheet1\n\n| a |\n| --- |\n| 1 |`) });
        const element = mount(`same.xlsx`);
        await settle();

        expect(element.textContent?.split(`The text is the same in both versions`)).toHaveLength(2);
    });

    it(`reads an added file as one added text, with no before side to speak of`, async () => {
        answers.set(`new.pdf`, { after: side(`A fresh page.`) });
        const element = mount(`new.pdf`);
        await settle();

        expect(element.querySelector(`ins`)?.textContent).toBe(`A fresh page.`);
        expect(element.textContent).not.toContain(`same in both versions`);
    });

    it(`names the version nothing could read, and offers the other reading in its place`, async () => {
        answers.set(`odd.docx`, { before: { present: false, reason: `derive-failed (docx): not a zip` }, after: side(`Fine.`) });
        const element = mount(`odd.docx`);
        await settle();

        expect(element.textContent).toContain(`The before version of odd.docx could not be read as text: derive-failed (docx): not a zip.`);
        expect(element.querySelectorAll(`ins, del`)).toHaveLength(0);
        const offer = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Show both versions instead`));
        expect(offer?.textContent).toContain(`Show both versions instead`);
        offer?.click();
        expect(sidesRequested).toHaveLength(1);
    });

    it(`shows a failed call as an error with a retry, not an empty diff`, async () => {
        answers.set(`down.docx`, new Error(`Request failed (503).`));
        const element = mount(`down.docx`);
        await settle();

        expect(element.textContent).toContain(`Request failed (503).`);
        expect([...element.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Try again`))).toBe(true);
    });
});
