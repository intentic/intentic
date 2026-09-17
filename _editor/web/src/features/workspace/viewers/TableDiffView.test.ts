// @vitest-environment jsdom
// Pins what a reviewer of a changed table reads: one grid per sheet, the changed cell drawn as both values, a dropped
// row struck through, and the count of rows that moved handed to the host.
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { Sheet } from "./tableDiff";
import TableDiffView from "./TableDiffView.vue";

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
    it(`draws a changed cell as what it was and what it became, in one grid with the header kept`, () => {
        const element = mount([sheet(`Prices`, [`Item`, `Cost`], [`Bread`, `2`])], [sheet(`Prices`, [`Item`, `Cost`], [`Bread`, `3`])]);

        expect(element.querySelectorAll(`table`)).toHaveLength(1);
        expect(element.querySelector(`th, tr`)?.textContent).toContain(`Item`);
        expect(element.querySelector(`del`)?.textContent).toBe(`2`);
        expect(element.querySelector(`ins`)?.textContent).toBe(`3`);
        expect(element.textContent).toContain(`1 row changed`);
        expect(counts).toEqual([1]);
    });

    it(`strikes a dropped row through and badges a sheet that is gone or new`, () => {
        const element = mount([sheet(`Old`, [`h`], [`gone`]), sheet(`S`, [`h`], [`x`])], [sheet(`S`, [`h`]), sheet(`New`, [`h`], [`fresh`])]);

        expect(element.textContent).toContain(`sheet removed`);
        expect(element.textContent).toContain(`new sheet`);
        const struck = [...element.querySelectorAll(`del`)].map((node) => node.textContent);
        expect(struck).toContain(`x`);
        // Every row of the removed sheet, the dropped row, and every row of the new sheet.
        expect(counts).toEqual([2 + 1 + 2]);
    });

    it(`folds long unchanged stretches to one line and opens them in place`, () => {
        const rows = Array.from({ length: 30 }, (_, index) => [`r${index}`]);
        const element = mount([sheet(`S`, [`h`], ...rows, [`tail`])], [sheet(`S`, [`h`], ...rows, [`changed tail`])]);

        // 31 unchanged rows (header + 30), less the header kept and one row of context above the change.
        const fold = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`unchanged rows`));
        expect(fold?.textContent).toContain(`${rows.length + 1 - 1 - 1} unchanged rows`);
        expect(element.querySelectorAll(`tbody tr`).length).toBeLessThan(10);
    });
});
