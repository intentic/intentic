import { strToU8, zipSync } from "fflate";
import { isOdfSpreadsheet, odfMimetype, readOdsBook } from "./sheet";
import { contentXml, odfBytes, SHEET_MIME, TEXT_MIME } from "./testing";
import { toRows } from "../sheetCells";

/* An .ods as the grid a reader sees. */

// ODF keeps every number in `office:value` whatever it is a number OF; only date, time and boolean have an
// attribute of their own.
const NUMERIC = new Set([`float`, `percentage`, `currency`]);
const cell = (type: string, value: string, shown: string): string =>
    `<table:table-cell office:value-type="${type}" ${NUMERIC.has(type) ? `office:value` : `office:${type}-value`}="${value}"><text:p>${shown}</text:p></table:table-cell>`;

const sheetOf = (tables: string): Uint8Array =>
    odfBytes({ mimetype: SHEET_MIME, content: contentXml(`<office:spreadsheet>${tables}</office:spreadsheet>`) });

const rowsOf = (tables: string) => readOdsBook(sheetOf(tables)).map((sheet) => ({ name: sheet.name, rows: toRows(sheet.data) }));

describe(`odfMimetype`, () => {
    it(`reads the package type without inflating anything`, () => {
        expect(odfMimetype(sheetOf(`<table:table table:name="A"/>`))).toBe(SHEET_MIME);
        expect(isOdfSpreadsheet(sheetOf(`<table:table table:name="A"/>`))).toBe(true);
    });

    it(`does not claim another kind of OpenDocument, or another kind of zip`, () => {
        expect(isOdfSpreadsheet(odfBytes({ mimetype: TEXT_MIME, content: contentXml(`<office:text/>`) }))).toBe(false);
        // An .xlsx is a zip too, and its first entry is not a mimetype.
        expect(isOdfSpreadsheet(zipSync({ "[Content_Types].xml": strToU8(`<Types/>`) }))).toBe(false);
        expect(odfMimetype(new Uint8Array([1, 2, 3]))).toBeUndefined();
    });
});

describe(`readOdsBook`, () => {
    it(`reads every sheet, in the file's order, by name`, () => {
        const book = rowsOf(
            `<table:table table:name="Sales"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell></table:table-row></table:table>` +
                `<table:table table:name="Costs"><table:table-row><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>`,
        );
        expect(book.map((sheet) => sheet.name)).toEqual([`Sales`, `Costs`]);
        expect(book[1]?.rows).toEqual([[`b`]]);
    });

    it(`keeps a number a number, so the column still lines up on the right`, () => {
        const book = rowsOf(`<table:table table:name="S"><table:table-row>${cell(`float`, `12.5`, `12.50`)}</table:table-row></table:table>`);
        expect(book[0]?.rows).toEqual([[12.5]]);
    });

    it(`shows a formatted cell the way the file displays it`, () => {
        const row = `<table:table-row>${cell(`percentage`, `0.15`, `15%`)}${cell(`currency`, `9.99`, `$9.99`)}</table:table-row>`;
        expect(rowsOf(`<table:table table:name="S">${row}</table:table>`)[0]?.rows).toEqual([[`15%`, `$9.99`]]);
    });

    it(`reads dates and times, and a boolean as a boolean`, () => {
        const row =
            `<table:table-row>${cell(`date`, `2026-01-15`, `01/15/2026`)}` +
            `<table:table-cell office:value-type="time" office:time-value="PT14H30M05S"><text:p>2:30 PM</text:p></table:table-cell>` +
            `${cell(`boolean`, `true`, `TRUE`)}</table:table-row>`;
        expect(rowsOf(`<table:table table:name="S">${row}</table:table>`)[0]?.rows).toEqual([[`2026-01-15`, `14:30:05`, true]]);
    });

    it(`expands a repeated cell but does not materialise the padding a sheet ends with`, () => {
        // Every .ods row is filled out to the sheet's full width with repeated empty cells; rendering those would
        // be a thousand blank columns per row.
        const row =
            `<table:table-row><table:table-cell table:number-columns-repeated="3"><text:p>x</text:p></table:table-cell>` +
            `<table:table-cell table:number-columns-repeated="16384"/></table:table-row>`;
        expect(rowsOf(`<table:table table:name="S">${row}</table:table>`)[0]?.rows).toEqual([[`x`, `x`, `x`]]);
    });

    it(`keeps an empty cell BETWEEN two filled ones, which is a hole in the data rather than padding`, () => {
        const row =
            `<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell>` +
            `<table:table-cell table:number-columns-repeated="2"/>` +
            `<table:table-cell><text:p>b</text:p></table:table-cell></table:table-row>`;
        expect(rowsOf(`<table:table table:name="S">${row}</table:table>`)[0]?.rows).toEqual([[`a`, null, null, `b`]]);
    });

    it(`reads header rows and row groups as rows of the same sheet`, () => {
        const table =
            `<table:table table:name="S"><table:table-header-rows><table:table-row><table:table-cell><text:p>Head</text:p></table:table-cell></table:table-row></table:table-header-rows>` +
            `<table:table-rows><table:table-row><table:table-cell><text:p>Body</text:p></table:table-cell></table:table-row></table:table-rows></table:table>`;
        expect(rowsOf(table)[0]?.rows).toEqual([[`Head`], [`Body`]]);
    });

    it(`does not read a table inside a cell as more rows of the sheet`, () => {
        const nested =
            `<table:table table:name="S"><table:table-row><table:table-cell>` +
            `<table:table table:name="Inner"><table:table-row><table:table-cell><text:p>deep</text:p></table:table-cell></table:table-row></table:table>` +
            `</table:table-cell></table:table-row></table:table>`;
        expect(rowsOf(nested)[0]?.rows).toHaveLength(1);
    });

    it(`answers with nothing for a package that holds no spreadsheet`, () => {
        expect(readOdsBook(odfBytes({ mimetype: TEXT_MIME, content: contentXml(`<office:text/>`) }))).toEqual([]);
    });
});
