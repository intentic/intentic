import type { SheetCell, SheetRows } from "./sheetProtocol";

/* Turning what the parser hands back into what the template renders. Its own module rather than a private
 * helper in sheetWorker.ts because that file installs a `self.addEventListener` the moment it is imported,
 * which is not a thing a test can import, and this is the half worth testing. */

// A Date survives structured cloning, but formatting it here keeps that work off the main thread and leaves
// the template with the one distinction it renders differently: a number, which aligns right.
export const toCell = (value: unknown): SheetCell => {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        // A date cell with no time is the overwhelmingly common case and reads worse with a midnight stamp
        // welded on, so the time half appears only when the cell actually carries one.
        const iso = value.toISOString();
        return iso.endsWith(`T00:00:00.000Z`) ? iso.slice(0, 10) : iso.slice(0, 19).replace(`T`, ` `);
    }
    if (typeof value === `number` || typeof value === `boolean` || typeof value === `string`) {
        return value;
    }
    // Nothing else is expected. Rendering `[object Object]` beats throwing away the rest of the sheet.
    return String(value);
};

export const toRows = (data: readonly (readonly unknown[])[]): SheetRows => data.map((row) => row.map((cell) => toCell(cell)));
