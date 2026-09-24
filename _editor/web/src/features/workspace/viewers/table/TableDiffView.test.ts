// Pins what a reviewer of a changed table reads: one grid per sheet, the changed cell drawn as both values, a dropped
// row struck through, and the count of rows that moved handed to the host.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { type Sheet, type SheetDiff, tableDiff } from "./tableDiff";
import type { TableDiffArgs } from "./tableDiffClient";

// The diff answered on this thread, as the worker would; a test that holds an answer back replaces one call.
const requestTableDiff = jest.fn<(args: TableDiffArgs) => Promise<SheetDiff[]>>(async ({ before, after }) => tableDiff(before, after));
jest.mock(`./tableDiffClient`, () => ({ requestTableDiff }));

const { default: TableDiffView } = await import(`./TableDiffView.vue`);

let app: App | undefined;
const counts: number[] = [];
const mount = (before: Sheet[], after: Sheet[]): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(TableDiffView, { before, after, onChanged: (count: number) => counts.push(count) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    counts.length = 0;
});

const sheet = (name: string, ...rows: string[][]): Sheet => ({ name, rows });

describe(`TableDiffView`, () => {
    it(`draws a changed cell as what it was and what it became, in one grid with the header kept`, async () => {
        const element = mount([sheet(`Prices`, [`Item`, `Cost`], [`Bread`, `2`])], [sheet(`Prices`, [`Item`, `Cost`], [`Bread`, `3`])]);

        await waitFor(() => expect(element.querySelectorAll(`table`)).toHaveLength(1));
        expect(element.querySelector(`th, tr`)?.textContent).toContain(`Item`);
        expect(element.querySelector(`del`)?.textContent).toBe(`2`);
        expect(element.querySelector(`ins`)?.textContent).toBe(`3`);
        expect(element.textContent).toContain(`1 row changed`);
        expect(counts).toEqual([1]);
    });

    it(`strikes a dropped row through and badges a sheet that is gone or new`, async () => {
        const element = mount([sheet(`Old`, [`h`], [`gone`]), sheet(`S`, [`h`], [`x`])], [sheet(`S`, [`h`]), sheet(`New`, [`h`], [`fresh`])]);

        await waitFor(() => expect(element.textContent).toContain(`sheet removed`));
        expect(element.textContent).toContain(`new sheet`);
        const struck = [...element.querySelectorAll(`del`)].map((node) => node.textContent);
        expect(struck).toContain(`x`);
        // Every row of the removed sheet, the dropped row, and every row of the new sheet.
        expect(counts).toEqual([2 + 1 + 2]);
    });

    it(`folds long unchanged stretches to one line and opens them in place`, async () => {
        const rows = Array.from({ length: 30 }, (_, index) => [`r${index}`]);
        const element = mount([sheet(`S`, [`h`], ...rows, [`tail`])], [sheet(`S`, [`h`], ...rows, [`changed tail`])]);

        // 31 unchanged rows (header + 30), less the header kept and one row of context above the change.
        await waitFor(() => {
            const fold = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`unchanged rows`));
            expect(fold?.textContent).toContain(`${rows.length + 1 - 1 - 1} unchanged rows`);
        });
        expect(element.querySelectorAll(`tbody tr`).length).toBeLessThan(10);
    });

    it(`says it is comparing until the diff arrives, and never draws the answer to a pair it has moved on from`, async () => {
        const pair = ref<[Sheet[], Sheet[]]>([[sheet(`S`, [`id`, `v`], [`1`, `old`])], [sheet(`S`, [`id`, `v`], [`1`, `stale`])]]);
        let answerStale: (() => void) | undefined;
        requestTableDiff.mockImplementationOnce(
            ({ before, after }) => new Promise<SheetDiff[]>((resolve) => (answerStale = () => resolve(tableDiff(before, after)))),
        );
        const element = document.createElement(`div`);
        document.body.append(element);
        app = createApp({
            render: () => h(TableDiffView, { before: pair.value[0], after: pair.value[1], onChanged: (count: number) => counts.push(count) }),
        });
        app.component(`Icon`, IconStub);
        app.directive(`tooltip`, {});
        app.mount(element);

        expect(element.querySelector(`[role="status"]`)?.textContent).toBe(`Comparing the two versions…`);
        expect(element.querySelector(`table`)).toBeNull();

        pair.value = [[sheet(`S`, [`id`, `v`], [`1`, `old`])], [sheet(`S`, [`id`, `v`], [`1`, `fresh`])]];
        await waitFor(() => expect(element.querySelector(`ins`)?.textContent).toBe(`fresh`));
        answerStale?.();
        await new Promise((settle) => setTimeout(settle, 0));

        expect(element.querySelector(`ins`)?.textContent).toBe(`fresh`);
        expect(element.querySelector(`[role="status"]`)).toBeNull();
        expect(counts).toEqual([1]);
    });
});
