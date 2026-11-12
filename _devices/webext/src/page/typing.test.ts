import "@intentic/testing/dom";
import { collectPage } from "./driver.js";
import { checkField, focusField, pressEnterInField, typeRich, typeValue } from "./typing.js";
import type { ActionResult } from "./driver.js";

// fill's steps in a page, against jsdom with the editors modelled by hand: each model keeps its own text and ignores a
// direct write to the DOM, which is the thing that made a ChatGPT composer look filled while its Send stayed disabled.
// jsdom has no execCommand, no ClipboardEvent and no DataTransfer; the tests that need them stand them in as Chrome's.

beforeEach(() => {
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    document.body.innerHTML = "";
});

const stood: string[] = [];
afterEach(() => {
    for (const name of stood.splice(0)) {
        Reflect.deleteProperty(globalThis, name);
        Reflect.deleteProperty(document, name);
    }
});
const standIn = (target: object, name: string, value: object): void => {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
    stood.push(name);
};

// What the background runs, step by step (tools/page.ts typeInto), with the page in-process.
const fill = async (ref: string, text: string, submit = false): Promise<ActionResult> => {
    const focused = await focusField(ref);
    if (!focused.ok) {
        return focused;
    }
    const typed = focused.rich === true ? typeRich(text) : typeValue(text);
    if (!typed.ok) {
        return typed;
    }
    const checked = await checkField(ref, text);
    if (!checked.ok || !submit) {
        return checked;
    }
    const pressed = pressEnterInField();
    return pressed.ok ? { ...checked, message: pressed.message } : pressed;
};

interface EditorModel {
    lines: string[];
    readonly sent: string[];
}

// Chrome's DataTransfer and paste event, which jsdom lacks.
class Transfer {
    readonly #data = new Map<string, string>();
    setData(type: string, value: string): void {
        this.#data.set(type, value);
    }
    getData(type: string): string {
        return this.#data.get(type) ?? "";
    }
}
class Clipboard extends Event {
    readonly clipboardData: Transfer | undefined;
    constructor(type: string, init: EventInit & { clipboardData?: Transfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
    }
}
const standInClipboard = (): void => {
    standIn(globalThis, "DataTransfer", Transfer);
    standIn(globalThis, "ClipboardEvent", Clipboard);
};

// A rich editor as Lexical and Slate are: its text lives in its own model, edited only from the `beforeinput` and
// `paste` it handles, and it puts its own rendering back over anything else written into its DOM.
const modelEditor = (options: { paste: boolean }) => {
    document.body.innerHTML = `<form><div contenteditable="true" role="textbox" aria-label="Ask"></div><button disabled>Send</button></form>`;
    const host = document.querySelector("[contenteditable]");
    const send = document.querySelector("button");
    if (!(host instanceof HTMLElement) || send === null) {
        throw new Error("the editor did not render");
    }
    const editor: EditorModel = { lines: [], sent: [] };
    const render = (): void => {
        observer.disconnect();
        host.innerHTML = editor.lines.map((line) => `<p>${line === "" ? "<br>" : line}</p>`).join("");
        send.disabled = editor.lines.join("") === "";
        observer.observe(host, { childList: true, subtree: true, characterData: true });
    };
    const observer = new MutationObserver(() => render());
    render();
    // Everything is selected when typing starts (focusField), so the first edit replaces what was there.
    let fresh = true;
    const replace = (): string[] => {
        const lines = fresh ? [""] : editor.lines;
        fresh = false;
        return lines;
    };
    host.addEventListener("beforeinput", (event) => {
        if (!(event instanceof InputEvent)) {
            return;
        }
        event.preventDefault();
        const lines = replace();
        if (event.inputType === "insertText") {
            lines[lines.length - 1] = `${lines.at(-1) ?? ""}${event.data ?? ""}`;
        } else if (event.inputType === "insertParagraph") {
            lines.push("");
        }
        editor.lines = lines;
        render();
    });
    host.addEventListener("paste", (event) => {
        const data = event instanceof Clipboard ? event.clipboardData : undefined;
        if (!options.paste || data === undefined) {
            return;
        }
        event.preventDefault();
        replace();
        editor.lines = data.getData("text/plain").split("\n");
        render();
    });
    host.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Enter" && event.keyCode === 13) {
            event.preventDefault();
            if (!send.disabled) {
                editor.sent.push(editor.lines.join("\n"));
            }
        }
    });
    return { host, send, editor };
};

test("an <input> a framework tracks gets its value through the native setter, and the events it listens for", async () => {
    document.body.innerHTML = `<form><input id="q" /></form>`;
    collectPage();
    const input = document.querySelector("input");
    if (input === null) {
        throw new Error("no input");
    }
    // React's value tracker: an assignment through the element's own `value` updates what React last saw, so the input
    // event that follows reads as no change, and onChange never runs. Only the prototype's setter gets past it.
    let tracked = "";
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    Object.defineProperty(input, "value", {
        configurable: true,
        get: () => native?.get?.call(input),
        set: (value: string) => {
            tracked = value;
            native?.set?.call(input, value);
        },
    });
    const changes: string[] = [];
    const events: string[] = [];
    input.addEventListener("input", () => {
        events.push("input");
        if (input.value !== tracked) {
            tracked = input.value;
            changes.push(input.value);
        }
    });
    input.addEventListener("change", () => events.push("change"));
    expect(await fill("e0", "hello")).toEqual({ ok: true, message: "typed" });
    expect(input.value).toBe("hello");
    expect(changes).toEqual(["hello"]);
    expect(events).toEqual(["input", "change"]);
});

test("a page that reformats what was typed says what the field now reads, and a password's value is never repeated", async () => {
    document.body.innerHTML = `<input id="tel" /><input type="password" id="pw" />`;
    collectPage();
    for (const input of Array.from(document.querySelectorAll("input"))) {
        input.addEventListener("input", () => {
            input.value = input.value.replace(/^(\d{3})(\d{3})$/, "$1-$2").toUpperCase();
        });
    }
    expect(await fill("e0", "123456")).toMatchObject({ ok: true, note: `the page changed it: the field now reads "123-456"` });
    const password = await fill("e1", "secret");
    expect(password.ok).toBe(true);
    expect(JSON.stringify(password)).not.toContain("SECRET");
});

test("a rich editor that ignores its DOM being written takes the text through beforeinput, and its Send wakes up", async () => {
    const { host, send, editor } = modelEditor({ paste: true });
    collectPage();
    // What fill used to do: the DOM shows the text for a moment, the editor puts its own back, and Send stays off.
    host.textContent = "draw a fox";
    await new Promise((done) => setTimeout(done, 0));
    expect(editor.lines.join("")).toBe("");
    expect(send.disabled).toBe(true);

    expect(await fill("e0", "draw a fox")).toEqual({ ok: true, message: "typed" });
    expect(editor.lines).toEqual(["draw a fox"]);
    expect(send.disabled).toBe(false);
});

test("text an editor already holds is replaced, not added to", async () => {
    const { editor } = modelEditor({ paste: true });
    editor.lines = ["an old draft"];
    collectPage();
    expect((await fill("e0", "a new one")).ok).toBe(true);
    expect(editor.lines).toEqual(["a new one"]);
});

test("execCommand, where the browser runs it, is the way in, as Chrome edits a ProseMirror composer", async () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Ask ChatGPT"><p>old</p></div>`;
    const host = document.querySelector("div");
    collectPage();
    const commands: string[] = [];
    // Chrome's insertText replaces the selection with the text and fires `input`; ProseMirror reads the DOM it changed.
    standIn(document, "execCommand", (command: string, _ui: boolean, value?: string) => {
        commands.push(`${command} ${value ?? ""}`.trim());
        const range = window.getSelection()?.getRangeAt(0);
        if (command !== "insertText" || range === undefined || value === undefined) {
            return false;
        }
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
        host?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        return true;
    });
    expect(await fill("e0", "a kite at dusk")).toEqual({ ok: true, message: "typed" });
    expect(commands).toEqual(["insertText a kite at dusk"]);
    expect(host?.textContent).toBe("a kite at dusk");
});

test("several lines go in as one paste, which the editor turns into its own paragraphs", async () => {
    standInClipboard();
    const { host, editor } = modelEditor({ paste: true });
    collectPage();
    expect(await fill("e0", "first line\nsecond line\n\nfourth")).toEqual({ ok: true, message: "typed" });
    expect(editor.lines).toEqual(["first line", "second line", "", "fourth"]);
    expect(host.querySelectorAll("p")).toHaveLength(4);
});

test("several lines into an editor that takes no paste are typed line by line, breaks kept", async () => {
    standInClipboard();
    const { editor } = modelEditor({ paste: false });
    collectPage();
    expect((await fill("e0", "one\ntwo")).ok).toBe(true);
    expect(editor.lines).toEqual(["one", "two"]);
});

test("a plain contenteditable with no editor behind it is written at the selection, lines as breaks", async () => {
    document.body.innerHTML = `<div contenteditable="true">was here</div>`;
    const host = document.querySelector("div");
    collectPage();
    expect(await fill("e0", "line one\nline two")).toEqual({ ok: true, message: "typed" });
    expect(host?.innerHTML).toBe("line one<br>line two");
});

test("a ref on an editor's wrapper types into the editor inside it", async () => {
    document.body.innerHTML = `<div role="textbox" aria-label="Message"><div contenteditable="true"></div></div>`;
    collectPage();
    expect((await fill("e0", "hi")).ok).toBe(true);
    expect(document.querySelector("[contenteditable]")?.textContent).toBe("hi");
});

test("an editor that does not take the text is reported as such, and nothing is submitted", async () => {
    const { host, editor } = modelEditor({ paste: true });
    // An editor that swallows every edit and puts its own DOM back over anything written, as one still starting up does.
    host.addEventListener("beforeinput", (event) => event.stopImmediatePropagation(), { capture: true });
    const keys: string[] = [];
    host.addEventListener("keydown", (event) => keys.push(event.type));
    collectPage();
    const result = await fill("e0", "draw a fox", true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not land");
    expect(result.message).toContain("nothing was submitted");
    expect(editor.sent).toEqual([]);
    expect(keys).toEqual([]);
});

test("submit presses Enter with the key fields an editor reads, and the editor sends once", async () => {
    const { editor } = modelEditor({ paste: true });
    let submitted = 0;
    document.querySelector("form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitted += 1;
    });
    collectPage();
    expect(await fill("e0", "draw a fox", true)).toEqual({ ok: true, message: "pressed Enter" });
    expect(editor.sent).toEqual(["draw a fox"]);
    // The editor took the Enter, so its form is not submitted besides: that would be a second send.
    expect(submitted).toBe(0);
});

test("Enter in an <input> nobody handles submits its form, as the browser's implicit submission does", async () => {
    document.body.innerHTML = `<form><input name="q" /></form>`;
    let submitted = 0;
    document.querySelector("form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitted += 1;
    });
    collectPage();
    expect((await fill("e0", "weather", true)).ok).toBe(true);
    expect(submitted).toBe(1);
});

test("a field that left the page before typing is gone, not typed into", async () => {
    document.body.innerHTML = `<input />`;
    collectPage();
    document.body.innerHTML = "";
    expect(await fill("e0", "x")).toMatchObject({ ok: false, gone: true });
});

test("an <input> is held to exactly what was asked, so a page that trims a password is reported", async () => {
    document.body.innerHTML = `<input type="password" /><textarea></textarea><input id="one-line" />`;
    collectPage();
    const [password] = Array.from(document.querySelectorAll("input"));
    password?.addEventListener("input", () => {
        password.value = password.value.trim();
    });
    // Rich-editor normalizing would have called " hunter2 " and "hunter2" the same.
    const trimmed = await fill("e0", " hunter2 ");
    expect(trimmed).toEqual({ ok: true, message: "typed", note: "the page changed what the field holds" });
    // A textarea keeps every line break and space as typed, and is held to them.
    expect(await fill("e1", "two  spaces\n\nand a blank line")).toEqual({ ok: true, message: "typed" });
    // An <input> drops line breaks by itself, as a browser does, which is no change by the page.
    expect(await fill("e2", "one\nline")).toEqual({ ok: true, message: "typed" });
});

test("Enter goes to the filled field even when focus wandered to another element meanwhile", async () => {
    document.body.innerHTML = `<form><input id="q" /><input id="other" /></form>`;
    collectPage();
    const heard: string[] = [];
    for (const input of Array.from(document.querySelectorAll("input"))) {
        input.addEventListener("keydown", () => heard.push(input.id));
    }
    document.querySelector("form")?.addEventListener("submit", (event) => event.preventDefault());
    expect((await focusField("e0")).ok).toBe(true);
    expect(typeValue("weather").ok).toBe(true);
    expect((await checkField("e0", "weather")).ok).toBe(true);
    document.getElementById("other")?.focus();
    expect(pressEnterInField().ok).toBe(true);
    expect(heard).toEqual(["q"]);
});
