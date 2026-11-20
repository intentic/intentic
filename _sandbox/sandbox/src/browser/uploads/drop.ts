import type { CDPSession, Page } from "playwright";

// Files dropped from the person's desktop onto the picture of a page, once uploaded (upload-store.ts): put down at the
// same point of the page. A file field under the point takes them as its value, the way dropping on one does in a
// desktop browser; anything else gets a real drag of files (Input.dispatchDragEvent), entering, moving over and dropping
// at the point, which is what a page's own drop zone listens for.

// Whether the point lands on a file field: the input itself, or a label for one. Answered in the page.
const fileFieldAt = (page: Page, x: number, y: number) =>
    page
        .evaluateHandle(
            ([left, top]) => {
                const hit = document.elementFromPoint(left, top);
                const input = hit instanceof HTMLLabelElement ? hit.control : hit?.closest(`input[type=file]`);
                return input instanceof HTMLInputElement && input.type === `file` && !input.disabled ? input : null;
            },
            [x, y] as const,
        )
        .then((handle) => handle.asElement());

/** Drops `files` on `page` at (x, y), in the page's CSS pixels. */
export const dropFiles = async (page: Page, session: CDPSession, x: number, y: number, files: readonly string[]): Promise<void> => {
    // allow(silent-catch): a page that cannot be asked (navigating) gets the drag, which needs no answer from it.
    const field = await fileFieldAt(page, x, y).catch(() => null);
    if (field !== null) {
        const multiple = await field.evaluate((input) => input instanceof HTMLInputElement && input.multiple);
        await field.setInputFiles(multiple ? [...files] : files.slice(0, 1));
        return;
    }
    // Copy is the one operation a file from outside can be dropped with.
    const data = { items: [], files: [...files], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await session.send("Input.dispatchDragEvent", { type, x, y, data });
    }
};
