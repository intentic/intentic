// What `fill` runs inside a tab, one step per injection: find and focus the field, put the text in, read it back, press
// Enter. Steps rather than one function because each step is small enough to read, and the field is handed from one to
// the next in a slot on the isolated world's window. The rule of driver.ts holds here: executeScript serializes each
// function and re-parses it in the page, so every helper is nested inside the step that uses it.
import type { ActionResult } from "./driver.js";

// The field `fill` is working on, between its steps. One slot: actions run one at a time.
declare global {
    interface Window {
        intenticFillField?: HTMLElement | undefined;
        // The refs collectPage minted and the element describeRef pinned (driver.ts), read here by the same names.
        intenticPageRefs?: Element[];
        intenticPinned?: { readonly pin: string; readonly el: Element } | undefined;
    }
}

// What focusing found: an <input> or <textarea> takes a value, anything else is a rich editor's contenteditable.
export interface FocusedForFill extends ActionResult {
    readonly rich?: boolean;
}

// Finds the field by its ref (or by the pin describeRef left, as clickRef does), focuses it, and for a rich editor
// selects everything it holds, so what is typed next replaces it. A ref on an editor's wrapper (a role=textbox div
// around the real field) is taken to the field inside it, and a ref on a paragraph inside an editor to the editor's
// root. The editor learns of the selection from `selectionchange`, which the browser fires as a task of its own:
// typing before it would land where the editor last had its caret, beside the old text rather than over it.
export const focusField = async (ref: string, pin?: string): Promise<FocusedForFill> => {
    window.intenticFillField = undefined;
    const pinned = window.intenticPinned;
    window.intenticPinned = undefined;
    const index = /^e(\d+)$/.exec(ref.trim());
    const byRef = index?.[1] === undefined ? undefined : window.intenticPageRefs?.[Number(index[1])];
    const el = pin === undefined ? byRef : pinned?.pin === pin ? pinned.el : undefined;
    if (el === undefined) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot.` };
    }
    if (!el.isConnected) {
        return { ok: false, gone: true, message: `${ref} is gone from the page: take a fresh snapshot.` };
    }
    // isContentEditable is the browser's own answer; the attribute stands in where it is not computed (a test DOM).
    const editable = (node: Element): boolean =>
        node instanceof HTMLElement && (node.isContentEditable ?? node.closest("[contenteditable]:not([contenteditable='false'])") !== null);
    const valued = (node: Element): node is HTMLInputElement | HTMLTextAreaElement => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
    const selectAll = async (host: HTMLElement): Promise<void> => {
        const selected = new Promise<void>((done) => {
            document.addEventListener("selectionchange", () => done(), { once: true });
            // A cap, in case no selectionchange comes.
            setTimeout(done, 50);
        });
        const all = document.createRange();
        all.selectNodeContents(host);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(all);
        await selected;
    };
    const field = valued(el) || editable(el) ? el : (el.querySelector("input, textarea, [contenteditable]:not([contenteditable='false'])") ?? el);
    if (valued(field)) {
        field.scrollIntoView?.({ block: "center" });
        field.focus();
        window.intenticFillField = field;
        return { ok: true, rich: false, message: `focused` };
    }
    if (!(field instanceof HTMLElement) || !editable(field)) {
        return { ok: false, message: `${ref} is a ${field.tagName.toLowerCase()}, which cannot be typed into.` };
    }
    let host = field;
    for (let at = field.parentElement; at !== null && editable(at); at = at.parentElement) {
        host = at;
    }
    host.scrollIntoView?.({ block: "center" });
    host.focus();
    await selectAll(host);
    window.intenticFillField = host;
    return { ok: true, rich: true, message: `focused` };
};

// An <input> or <textarea> gets its value through the prototype's native setter, not `el.value =`: React overrides
// that property, so a direct assign updates the display but not what the framework tracks.
export const typeValue = (text: string): ActionResult => {
    const field = window.intenticFillField;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !field.isConnected) {
        return { ok: false, gone: true, message: `The field left the page before anything was typed: take a fresh snapshot.` };
    }
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, message: `typed` };
};

// A contenteditable is a rich editor's surface (ProseMirror as ChatGPT uses, Lexical, Slate, Draft.js, Quill): each
// keeps its own model of the text and ignores a direct `textContent` write, so its Send stayed disabled over a field
// that only looked filled (ChatGPT, 2026-11). The text goes in the ways a person's typing or pasting reaches them:
// - Several lines: a synthetic paste of text/plain first. A paste is the one input every one of these editors turns
//   into its own paragraphs or breaks; execCommand("insertParagraph") edits the DOM without the `beforeinput` Lexical
//   and Slate edit from, so they put the old DOM back. An editor that handles a paste cancels it, and the browser
//   inserts nothing for a paste a script dispatched, so an uncancelled one means nothing went in and the text is
//   typed line by line instead.
// - A line: execCommand("insertText"), which every one of them honors. Where it does not run, a `beforeinput` the
//   editor may take; only if nothing took that, the DOM is written at the selection, with an `input` after it, as a
//   browser does for a plain contenteditable with no editor behind it.
export const typeRich = (text: string): ActionResult => {
    const host = window.intenticFillField;
    if (host === undefined || !host.isConnected) {
        return { ok: false, gone: true, message: `The field left the page before anything was typed: take a fresh snapshot.` };
    }
    const input = (inputType: string, data?: string): void => {
        host.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: data ?? null }));
    };
    // Writes a node where the selection is, inside the editor, or at its end.
    const place = (node: Node): void => {
        const selection = window.getSelection();
        const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (range === undefined || !host.contains(range.commonAncestorContainer)) {
            host.append(node);
            return;
        }
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
    };
    // One edit, by the first way the page takes it.
    const edit = (command: string, inputType: string, value: string | undefined, write: () => Node): void => {
        if (document.execCommand?.(command, false, value) === true) {
            return;
        }
        // As a browser does, `input` follows only an edit the editor left to the DOM: Lexical inserts the data of an
        // `input` again, so one after a `beforeinput` it took would type the text twice.
        const taken = !host.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, data: value ?? null }));
        if (!taken) {
            place(write());
            input(inputType, value);
        }
    };
    const pasted = (): boolean => {
        if (!("ClipboardEvent" in window) || !("DataTransfer" in window)) {
            return false;
        }
        const data = new DataTransfer();
        data.setData("text/plain", text);
        return !host.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: data }));
    };
    const parts = text.replace(/\r\n?/g, "\n").split("\n");
    if (text === "") {
        if (document.execCommand?.("delete", false) !== true) {
            host.textContent = "";
            input("deleteContentBackward");
        }
        return { ok: true, message: `cleared` };
    }
    if (parts.length > 1 && pasted()) {
        return { ok: true, message: `pasted` };
    }
    parts.forEach((part, at) => {
        if (at > 0) {
            edit("insertParagraph", "insertParagraph", undefined, () => document.createElement("br"));
        }
        if (part !== "") {
            edit("insertText", "insertText", part, () => document.createTextNode(part));
        }
    });
    return { ok: true, message: `typed` };
};

// Reads the field back once the page has had its turn (Lexical reconciles a task later, React renders after the
// event), so the answer is what the page holds, not what was written into it. A rich editor that does not hold the
// text is reported, never called filled, and its form is not submitted: that is the field that looked filled while
// its Send stayed disabled. An <input> the page reformatted (a phone number, a date) still counts as typed, with what
// it now reads said, since the page made that of exactly this text; a password's value is never repeated.
export const checkField = async (ref: string, text: string): Promise<ActionResult> => {
    const field = window.intenticFillField;
    if (field === undefined || !field.isConnected) {
        return { ok: false, gone: true, message: `The field ${ref} left the page while it was being typed into: take a fresh snapshot before trying again.` };
    }
    // A task, not a timer: a page behind the person's window gets timers about once a second, messages at once.
    const tick = async (): Promise<void> =>
        await new Promise((done) => {
            const channel = new MessageChannel();
            channel.port1.addEventListener("message", () => {
                channel.port1.close();
                done();
            });
            channel.port1.start();
            channel.port2.postMessage(null);
        });
    // What a person reads in a rich editor: a line per paragraph or <br>.
    const readEditor = (root: Node): string =>
        Array.from(root.childNodes)
            .map((child) => {
                if (child instanceof HTMLBRElement) {
                    return "\n";
                }
                if (!(child instanceof Element)) {
                    return child.textContent ?? "";
                }
                const block = /^(P|DIV|LI|H[1-6]|PRE|BLOCKQUOTE|TR)$/.test(child.tagName);
                return block ? `\n${readEditor(child)}\n` : readEditor(child);
            })
            .join("");
    const valued = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
    const read = (): string => (valued ? field.value : readEditor(field));
    // Editors normalize: spaces collapse, a blank line becomes an empty paragraph or none, nbsp stands in for a space,
    // and Slate and Lexical keep zero-width marks in empty lines.
    const lines = (value: string): string[] =>
        value
            .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
            .replace(/\u00A0/g, " ")
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t]+/g, " ").trim())
            .filter((line) => line !== "");
    const quote = (value: string): string => JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
    // An <input> or <textarea> is held to exactly what was asked, so a page that trims or cuts a value (a password
    // included) is reported; an <input> drops line breaks by itself, as the browser's own sanitizing does. Only a rich
    // editor gets the normalized comparison, since it re-renders the text its own way.
    const asked = field instanceof HTMLInputElement ? text.replace(/\r?\n|\r/g, "") : text.replace(/\r\n?/g, "\n");
    const want = lines(text);
    const held = (): boolean => (valued ? field.value === asked : lines(read()).join("\n") === want.join("\n"));
    await tick();
    await tick();
    if (!held()) {
        // Some pages render a moment after a task or two (a React state update behind the editor).
        // allow(primitive-tiers): injected into the page, where no import exists
        await new Promise((done) => setTimeout(done, 150));
    }
    if (held()) {
        return { ok: true, message: `typed` };
    }
    if (valued) {
        const note = field instanceof HTMLInputElement && field.type === "password" ? `the page changed what the field holds` : `the page changed it: the field now reads ${quote(field.value)}`;
        return { ok: true, message: `typed`, note };
    }
    const got = lines(read());
    if (got.join(" ") === want.join(" ")) {
        return { ok: true, message: `typed`, note: `the editor kept the words but not the line breaks as given` };
    }
    return {
        ok: false,
        message:
            got.length === 0
                ? `The text did not land: ${ref} is a rich text editor and still reads empty, so the page sees nothing typed and nothing was submitted. Take a snapshot to check, then try fill again.`
                : `The text did not land as asked: ${ref} now reads ${quote(got.join("\n"))}, so nothing was submitted. Take a snapshot to check before trying again.`,
    };
};

// Enter on the focused element with every key field an editor or a page reads (key, code, keyCode, which), as
// keydown, keypress and keyup. A form is submitted only for an <input>, and only when no handler took the Enter, as
// the browser's own implicit submission does: a chat composer handles Enter itself, and submitting its form as well
// would send the message twice.
export const pressEnterInField = (): ActionResult => {
    let focused: Element | null = document.activeElement;
    while (focused?.shadowRoot?.activeElement != null) {
        focused = focused.shadowRoot.activeElement;
    }
    const field = window.intenticFillField;
    window.intenticFillField = undefined;
    // The filled field gets the Enter, or what has focus inside it (an editor's inner node): focus that wandered off
    // to another element meanwhile must not get a submit meant for this field.
    const on = focused instanceof HTMLElement && field !== undefined && field.contains(focused) ? focused : field;
    if (on === undefined || !on.isConnected) {
        return { ok: false, gone: true, message: `The field left the page before Enter was pressed, so nothing was submitted: take a fresh snapshot.` };
    }
    const key = { bubbles: true, cancelable: true, composed: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    const down = on.dispatchEvent(new KeyboardEvent("keydown", key));
    const press = down && on.dispatchEvent(new KeyboardEvent("keypress", { ...key, charCode: 13 }));
    on.dispatchEvent(new KeyboardEvent("keyup", key));
    // requestSubmit (not form.submit()) runs validation and fires the submit event, as an Enter in a field does.
    if (down && press && on instanceof HTMLInputElement) {
        on.form?.requestSubmit();
    }
    return { ok: true, message: `pressed Enter` };
};
