import "@intentic/testing/dom";
import { renderPage, toPageState } from "@intentic/browser/page";
import { askConfirm, clickRef, collectPage, describeRef, fillRef, readPageText, selectRef, waitForText } from "./driver.js";

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
    // oxlint-disable-next-line typescript/no-implied-eval -- re-parsing the source is exactly what Chrome does with it
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
