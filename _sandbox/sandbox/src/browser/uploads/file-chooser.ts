import { randomUUID } from "node:crypto";
import type { BrowserFileChooser } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { FileChooser, Page } from "playwright";
import { opt } from "../../opt.js";

// A page's <input type=file> asking for files. Chromium's own dialog would open on the sandbox's disk, in a picture, so
// the ask is intercepted (Playwright's `filechooser`, which turns on Page.setInterceptFileChooserDialog) and held for the
// person, whose editor opens their own computer's picker; what they pick is uploaded (upload-store.ts) and set on the
// input as though it had been picked there. An agent's tool can answer the same ask (browser_file_upload), and
// whichever comes first counts, as with a dialog.

export interface HeldFileChooser {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly multiple: boolean;
    readonly accept: readonly string[] | undefined;
}

const held = new WeakMap<Page, HeldFileChooser>();

// The accept attribute as its parts: `.pdf, image/*` is two. An empty or absent one takes anything.
const acceptOf = (attribute: string | null | undefined): string[] | undefined => {
    const parts = (attribute ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
    return parts.length === 0 ? undefined : parts;
};

/** Holds every file chooser `page` opens until it is answered; `changed` hears one arriving or going. */
export const watchFileChooser = (page: Page, changed: () => void): void => {
    page.on("filechooser", (chooser) => {
        void (async () => {
            // allow(silent-catch): an input gone before its attribute could be read takes anything, as it would have.
            const accept = acceptOf(await chooser.element().getAttribute("accept").catch(() => null));
            held.set(page, { id: randomUUID(), chooser, multiple: chooser.isMultiple(), accept });
            changed();
        })();
    });
    page.once("close", () => held.delete(page));
};

/** The chooser `page` is waiting on, as the window's state says it. */
export const fileChooserOf = (page: Page, pageId: string): BrowserFileChooser | undefined => {
    const chooser = held.get(page);
    return chooser === undefined ? undefined : { id: chooser.id, pageId, multiple: chooser.multiple, ...opt("accept", chooser.accept === undefined ? undefined : [...chooser.accept]) };
};

/**
 * Answers the chooser `id` if it is `page`'s, with these files (several only where the input takes several), or cancels
 * it with none: the input then hears `cancel`, as when a person closes the picker. False when `page` holds no such ask.
 */
export const answerFileChooser = async (page: Page, id: string, files: readonly string[]): Promise<boolean> => {
    const chooser = held.get(page);
    if (chooser?.id !== id) {
        return false;
    }
    held.delete(page);
    if (files.length === 0) {
        await chooser.chooser
            .element()
            .evaluate((input) => input.dispatchEvent(new Event("cancel", { bubbles: true })))
            // allow(silent-catch): an input gone with its page has nobody to tell.
            .catch(() => undefined);
        return true;
    }
    await chooser.chooser.setFiles(chooser.multiple ? [...files] : files.slice(0, 1));
    return true;
};
