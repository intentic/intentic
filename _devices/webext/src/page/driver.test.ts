import "@intentic/testing/dom";
import { renderPage, toPageState } from "@intentic/browser/page";
import { askConfirm } from "./overlay.js";
import { clickRef, collectPage, describeRef, fillRef, pinFocusedField, readPageText, selectRef, typeSecretInto, waitForText } from "./driver.js";

// Tests the page walk against real DOM via jsdom, which is enough for the judgements that matter (what's clickable,
// what to call it, sensitivity) but cannot lay out elements or run a page's own JavaScript.

// jsdom lays out nothing (0×0 elements); stub a non-zero box so the visibility filter doesn't drop everything.
beforeEach(() => {
    Element.prototype.getBoundingClientRect = () => ({
        width: 100,
        height: 20,
        top: 0,
        left: 0,
        right: 100,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
    document.body.innerHTML = "";
});

test("the walk answers in the same language the CDP driver speaks", () => {
    document.title = "Inbox";
    document.body.innerHTML = `
        <a href="/one">Invoice 2291</a>
        <input type="text" name="q" value="unpaid" />
        <input type="password" name="pw" value="hunter2" />
        <button>Send</button>
        <div>not interesting</div>`;
    const page = collectPage();
    const rendered = renderPage(toPageState(page), page.truncated);
    expect(rendered).toContain(`[e0] link "Invoice 2291"`);
    expect(rendered).toContain(`[e1] textbox "q" = "unpaid"`);
    expect(rendered).toContain(`[e3] button "Send"`);
    // The password field is listed; its value never is.
    expect(rendered).toContain(`[e2] password`);
    expect(rendered).not.toContain(`hunter2`);
});

test("elements inside a shadow root are found, because that is where half the web keeps its buttons", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<button>Buy now</button>`;
    const page = collectPage();
    expect(page.elements.some((element) => element.name === "Buy now")).toBe(true);
});

test("a reference from a previous page is refused rather than clicking whatever took its place", () => {
    document.body.innerHTML = `<button id="a">One</button>`;
    collectPage();
    document.body.innerHTML = `<button id="b">Something else entirely</button>`;
    const result = clickRef("e0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fresh snapshot");
    // A ref that was never minted at all.
    expect(clickRef("e99").ok).toBe(false);
    expect(clickRef("button.submit").ok).toBe(false);
});

test("typing writes the value the page's own framework will read, and fires what it listens for", () => {
    document.body.innerHTML = `<form><input id="q" /></form>`;
    collectPage();
    const input = document.getElementById("q") as HTMLInputElement;
    const events: string[] = [];
    for (const name of ["input", "change"]) {
        input.addEventListener(name, () => events.push(name));
    }
    expect(fillRef("e0", "hello", false).ok).toBe(true);
    expect(input.value).toBe("hello");
    expect(events).toEqual(["input", "change"]);
});

test("a payment or deletion button is flagged, so the person is asked before it is clicked", () => {
    document.body.innerHTML = `<button>Pay £240 now</button><button>Save draft</button><form><input type="password" /><button>Continue</button></form>`;
    collectPage();
    expect(describeRef("e0").sensitive).toBe(true);
    expect(describeRef("e1").sensitive).toBe(false);
    // Not because of its own words, but because of the form it is in.
    expect(describeRef("e3").sensitive).toBe(true);
});

// The owner's own pages are Polish, and a word ending in "ć" or "ń" once had no edge an ASCII `\b` could see. Judged by
// the function re-parsed alone, as the page runs it, so the word lists can't lean on anything outside it.
const judged = (labels: readonly string[]): boolean[] => {
    // oxlint-disable-next-line typescript/no-implied-eval -- re-parsing the source is exactly what Chrome does with it
    const alone = new Function(`return (${describeRef.toString()})`)() as typeof describeRef;
    document.body.innerHTML = labels.map((label) => `<button>${label}</button>`).join("");
    collectPage();
    return labels.map((_, index) => alone(`e${index}`).sensitive);
};

test("a Polish payment or deletion button is flagged, in every inflection a page words it in", () => {
    const money = [`Zapłać`, `Zapłać 240 zł`, `Zapłacić teraz`, `Płatność`, `Przejdź do płatności`, `Opłać zamówienie`, `Kup teraz`, `KUP TERAZ`];
    const more = [`Kupuję i płacę`, `Potwierdź zakup`, `Zamów`, `Zamawiam z obowiązkiem zapłaty`, `Złóż zamówienie`, `Wykonaj przelew`, `Przelej środki`];
    const still = [`Wpłać`, `Wypłać środki`, `Wypłata`, `Subskrybuj`, `Wykup subskrypcję`, `Przekaż darowiznę`, `Wesprzyj nas`, `Doładuj konto`];
    const destructive = [`Usuń`, `Usuń konto`, `Usunąć?`, `Usuwam`, `Skasuj`, `Dezaktywuj konto`, `Zamknij konto`, `Unieważnij token`, `Cofnij dostęp`];
    const gone = [`Wyczyść dane`, `Wymaż`, `Odinstaluj`, `Opróżnij kosz`, `Anuluj subskrypcję`, `Zakończ umowę`, `Usun konto`];
    for (const labels of [money, more, still, destructive, gone]) {
        expect(judged(labels)).toEqual(labels.map(() => true));
    }
});

test("the everyday words around them are not, nor a stem met inside another word", () => {
    const everyday = [`Zapisz szkic`, `Dalej`, `Wstecz`, `Zamknij`, `Anuluj`, `Cofnij`, `Zakończ`, `Szukaj`, `Kontakt`, `Pokaż więcej`];
    const inside = [`Bezpłatny`, `Kupon rabatowy`, `Skup złomu`, `Usługi`, `Wymagane`, `Display settings`, `Reorder list`, `Orders`];
    expect(judged([...everyday, ...inside])).toEqual([...everyday, ...inside].map(() => false));
});

test("a button that says it only in its attributes, or names its form from outside, is judged by that", () => {
    document.body.innerHTML = `
        <input type="submit" value="Zapłać" />
        <button aria-label="Usuń"><svg></svg></button>
        <form id="card"><input autocomplete="cc-number" /></form><button form="card">Dalej</button>`;
    collectPage();
    expect([describeRef("e0").sensitive, describeRef("e1").sensitive, describeRef("e3").sensitive]).toEqual([true, true, true]);
});

test("a dropdown can be chosen by the label a snapshot actually shows", () => {
    document.body.innerHTML = `<select><option value="gb">United Kingdom</option><option value="de">Germany</option></select>`;
    collectPage();
    expect(selectRef("e0", ["Germany"]).ok).toBe(true);
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("de");
    const missed = selectRef("e0", ["Atlantis"]);
    expect(missed.ok).toBe(false);
    // The refusal lists the valid options.
    expect(missed.message).toContain("United Kingdom");
});

test("reading a page prefers its main content to its chrome", () => {
    document.title = "Docs";
    document.body.innerHTML = `<nav>Home About</nav><main>The answer is 42.</main>`;
    // jsdom implements innerText as textContent, close enough for this assertion.
    const page = readPageText();
    expect(page.text).toContain("42");
    expect(page.text).not.toContain("About");
});

// executeScript sends the function's source and re-parses it in the page, where no name of this module exists. Re-parsed
// the same way here: an imported helper inside it would throw on the first look that missed, which Chrome hands back as
// a null result (the "Cannot read properties of null (reading 'message')" wait_for kept failing with).
test("wait_for's injected function still works with nothing of its module around it, as it runs in the page", async () => {
    // re-parsing the source is exactly what Chrome does with it
    const alone = new Function(`return (${waitForText.toString()})`)() as typeof waitForText;
    document.body.innerHTML = `<p>loading</p>`;
    setTimeout(() => {
        document.body.innerHTML = `<p>Saved</p>`;
    }, 300);
    expect(await alone("Saved", false, 5_000)).toEqual({ ok: true, message: `"Saved" appeared` });
    expect((await alone("never", false, 250)).ok).toBe(false);
});

// jsdom lays nothing out and has no hit test: `elementFromPoint` answers with what a pointer would land on here.
const pointingAt = (selector: string, run: () => void): void => {
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector(selector) });
    try {
        run();
    } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
    }
};

// PrimeVue's menus: the snapshot names the li[role=menuitem], and the menu's command listens on a div inside it. A
// click dispatched on the li bubbles up and away from that div, so the tool said "clicked" and nothing ran; a person's
// pointer lands on the label, and so does this.
test("a click lands where a person's pointer would, so a menu listening inside its item hears it", () => {
    document.body.innerHTML = `<ul role="menubar"><li role="menuitem" aria-label="Remove"><div class="content"><a><span>Remove</span></a></div></li></ul>`;
    collectPage();
    const heard: string[] = [];
    document.querySelector(".content")?.addEventListener("click", () => heard.push("command"));
    pointingAt("span", () => expect(clickRef("e1").ok).toBe(true));
    expect(heard).toEqual(["command"]);
});

test("whatever covers the element at that point does not get the click instead", () => {
    document.body.innerHTML = `<div class="backdrop"></div><button>Save</button>`;
    collectPage();
    const clicked: string[] = [];
    document.querySelector(".backdrop")?.addEventListener("click", () => clicked.push("backdrop"));
    document.querySelector("button")?.addEventListener("click", () => clicked.push("button"));
    pointingAt(".backdrop", () => expect(clickRef("e0").ok).toBe(true));
    expect(clicked).toEqual(["button"]);
});

// A snapshot taken while the person decides renumbers every ref; the yes was for the element they were shown.
test("the click after a question lands on the element asked about, though a snapshot renumbered the refs meanwhile", () => {
    document.body.innerHTML = `<button id="keep">Keep</button><button id="remove">Remove</button>`;
    collectPage();
    expect(describeRef("e1", "pin-1").name).toBe("Remove");
    document.body.insertAdjacentHTML("afterbegin", `<button id="new">Remove all</button>`);
    collectPage();
    const clicked: string[] = [];
    for (const button of Array.from(document.querySelectorAll("button"))) {
        button.addEventListener("click", () => clicked.push(button.id));
    }
    expect(clickRef("e1", "pin-1").ok).toBe(true);
    expect(clicked).toEqual(["remove"]);
    // A pin is spent by the click it was for.
    expect(clickRef("e1", "pin-1").ok).toBe(false);
});

test("an element that went away while the person was asked is reported as gone, not as a ref that never was", () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem">Remove</li></ul>`;
    collectPage();
    describeRef("e1", "pin-2");
    document.body.innerHTML = ``;
    expect(clickRef("e1", "pin-2")).toMatchObject({ ok: false, gone: true });
    expect(clickRef("e99").gone).toBeUndefined();
});

// The question's panel in the page, which is the last thing on <html> while it is up.
const panel = (): Element | null => document.documentElement.lastElementChild;

// A person's click on the panel used to reach the page as a click outside the menu the agent had opened, and the page
// closed it; the click they allowed then had nothing to land on.
test("the question is not part of the page: a snapshot cannot list it, and the page hears nothing aimed at it", async () => {
    const heard: string[] = [];
    const listen = (event: Event): void => {
        heard.push(event.type);
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "focusin", "keydown"];
    for (const type of types) {
        document.addEventListener(type, listen, true);
    }
    try {
        const answer = askConfirm(`Your agent wants to click "Remove". Allow it?`, 100);
        const host = panel();
        expect(host?.tagName).toBe("DIV");
        expect(collectPage().elements.some((element) => element.name === "Allow" || element.name === "No")).toBe(false);
        for (const type of types) {
            host?.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: 230, clientY: 10, detail: 1 }));
        }
        expect(heard).toEqual([]);
        // Not one of those was the person's, so nothing was answered: the question runs out as a no.
        expect(await answer).toBe(false);
        expect(panel()?.tagName).toBe("BODY");
        // And the page hears its own events again once the question has gone.
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(heard).toEqual(["click"]);
    } finally {
        for (const type of types) {
            document.removeEventListener(type, listen, true);
        }
    }
});

// Only a trusted event is the person's, and jsdom cannot make one, so the panel's own window listener is caught as it
// is added and handed events that say they are, as Chrome's would. The buttons are laid out apart, so a pointer
// position says which one was pressed.
const askCaught = () => {
    const box = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
        const left = this.textContent === "Allow" ? 200 : this.textContent === "No" ? 100 : -1;
        return left < 0 ? box.call(this) : { width: 60, height: 20, top: 0, left, right: left + 60, bottom: 20, x: left, y: 0, toJSON: () => ({}) };
    };
    const add = window.addEventListener;
    const caught: EventListenerOrEventListenerObject[] = [];
    window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
        if (type === "click") {
            caught.push(listener);
        }
        add(type, listener, options);
    };
    try {
        const answer = askConfirm(`Your agent wants to click "Remove". Allow it?`, 5_000);
        const send = (event: Event): void => {
            for (const listener of caught) {
                if ("handleEvent" in listener) {
                    listener.handleEvent(event);
                } else {
                    listener(event);
                }
            }
        };
        return { answer, send };
    } finally {
        window.addEventListener = add;
    }
};

// A press on the panel as Chrome delivers it: a real MouseEvent, aimed at the panel's host, saying whether it came
// from the person, and noting whether the panel prevented its default.
const press = (type: string, clientX: number, options: { readonly trusted?: boolean; readonly prevented?: string[] } = {}): MouseEvent =>
    new Proxy(new MouseEvent(type, { clientX, clientY: 10, detail: 1 }), {
        get: (event, key) =>
            key === "isTrusted"
                ? (options.trusted ?? true)
                : key === "target"
                  ? panel()
                  : key === "preventDefault"
                    ? () => options.prevented?.push(type)
                    : key === "stopImmediatePropagation"
                      ? () => undefined
                      : Reflect.get(event, key, event),
    });

test("only the person's own click answers, by the button under their pointer, and a press never takes focus", async () => {
    const { answer, send } = askCaught();
    const prevented: string[] = [];
    send(press("mousedown", 230, { prevented }));
    expect(prevented).toEqual(["mousedown"]);
    // The agent's click on Allow, or the page's, is not the person's.
    send(press("click", 230, { trusted: false }));
    // Nor is a click between the buttons an answer.
    send(press("click", 180));
    expect(panel()?.tagName).toBe("DIV");
    send(press("click", 230));
    expect(await answer).toBe(true);
    expect(panel()?.tagName).toBe("BODY");
});

test("the person's click on No is a no", async () => {
    const { answer, send } = askCaught();
    send(press("click", 130));
    expect(await answer).toBe(false);
});

/* A STORED SECRET, TYPED INTO THE FIELD IN FOCUS: the field is read and held first, and typed into only after the sandbox
   has released the value, which may be minutes later. */

const HERE = "http://localhost:3000";

// One element of the page by selector, of the kind the test needs it to be, or the test stops there.
const one = <T extends Element>(selector: string, kind: new () => T, root: ParentNode = document): T => {
    const found = root.querySelector(selector);
    if (!(found instanceof kind)) {
        throw new Error(`the page has no ${kind.name} at ${selector}`);
    }
    return found;
};

test("the focused field is held and named, a password input as a password field", () => {
    document.body.innerHTML = `<form><input id="user" /><input id="pw" type="password" /></form>`;
    one("#pw", HTMLInputElement).focus();
    expect(pinFocusedField("pin-1")).toEqual({ ok: true, field: "password", message: "" });
    one("#user", HTMLInputElement).focus();
    expect(pinFocusedField("pin-2")).toEqual({ ok: true, field: "text", message: "" });
});

test("nothing typeable in focus is refused, saying to click the field first", () => {
    document.body.innerHTML = `<button id="go">Go</button><input id="when" type="date" /><input id="off" disabled />`;
    for (const focused of [undefined, "go", "when"]) {
        if (focused !== undefined) {
            one(`#${focused}`, HTMLElement).focus();
        }
        const read = pinFocusedField("pin");
        expect(read.ok).toBe(false);
        expect(read.message).toBe(`No text field is focused on this page: click the field first, then type the secret again.`);
    }
    // Nothing was held, so nothing can be typed.
    expect(typeSecretInto("pin", "s3cret", HERE)).toMatchObject({ ok: false, gone: true });
});

test("a field inside a shadow root is the one held, not its host", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<input type="password" />`;
    host.shadowRoot?.querySelector("input")?.focus();
    expect(pinFocusedField("pin").field).toBe("password");
    expect(typeSecretInto("pin", "s3cret", HERE).ok).toBe(true);
    expect(host.shadowRoot?.querySelector("input")?.value).toBe("s3cret");
});

test("the secret goes into the held field the way a framework reads it, without submitting the form", () => {
    document.body.innerHTML = `<form><input id="pw" type="password" /><button>Sign in</button></form>`;
    const field = one("#pw", HTMLInputElement);
    const events: string[] = [];
    for (const name of ["input", "change", "keydown", "submit"]) {
        (name === "submit" ? one("form", HTMLFormElement) : field).addEventListener(name, (event) => {
            events.push(name);
            event.preventDefault();
        });
    }
    field.focus();
    pinFocusedField("pin");
    // Focus wandered while the person decided; the secret still goes where it was asked for.
    one("button", HTMLButtonElement).focus();
    expect(typeSecretInto("pin", "s3cret", HERE)).toEqual({ ok: true, message: "typed" });
    expect(field.value).toBe("s3cret");
    expect(events).toEqual(["input", "change"]);
});

test("a pin is good for one value, on the site it was taken on, for the field it held", () => {
    document.body.innerHTML = `<input id="pw" type="password" />`;
    const field = one("#pw", HTMLInputElement);
    field.focus();
    pinFocusedField("pin");
    const elsewhere = typeSecretInto("pin", "s3cret", "https://evil.example");
    expect(elsewhere).toEqual({ ok: false, message: `The page moved to another site while the secret was being released, so nothing was typed.` });
    // The refusal spent the pin too.
    expect(typeSecretInto("pin", "s3cret", HERE)).toMatchObject({ ok: false, gone: true });

    field.focus();
    pinFocusedField("pin-2");
    expect(typeSecretInto("someone-else", "s3cret", HERE)).toMatchObject({ ok: false, gone: true });

    field.focus();
    pinFocusedField("pin-3");
    field.remove();
    const gone = typeSecretInto("pin-3", "s3cret", HERE);
    expect(gone).toMatchObject({ ok: false, gone: true });
    expect(gone.message).toContain("Click the field again");
    expect(field.value).toBe("");
});
