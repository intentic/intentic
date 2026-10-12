import "@intentic/testing/dom";
import { renderPage, toPageState } from "@intentic/browser/page";
import { clickRef, collectPage, describeRef, fillRef, readPageText, selectRef, waitForText } from "./driver.js";

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
