import { renderPage, toPageState } from "@intentic/browser/page";
import { beforeEach, expect, test } from "vitest";
import { clickRef, collectPage, describeRef, fillRef, readPageText, selectRef } from "./driver.js";

/* THE PAGE WALK, against real DOM. jsdom is enough for every judgement these functions make — what is
 * clickable, what an element is called, whether a form deals in passwords or money — and those judgements are
 * where the bugs live: an extension that mislabels a button sends an agent to click the wrong one.
 *
 * What jsdom cannot test is the part that needs a rendering engine (`getBoundingClientRect` is always zero
 * there, so the visibility filter is stubbed per test) and the part that needs a real page's own JavaScript
 * (whether React noticed the typing). Those need a browser and a person. */

// jsdom lays nothing out, so every element measures 0×0 and the visibility filter would drop the page. Giving
// the prototype a non-zero box is the smallest lie that lets the rest be tested honestly.
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
    // The password FIELD is listed — an agent has to know the form has one — and what it holds never is.
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
    // And a ref that was never minted at all.
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
    // The refusal lists what it could have picked, so the next call is right rather than another guess.
    expect(missed.message).toContain("United Kingdom");
});

test("reading a page prefers its main content to its chrome", () => {
    document.title = "Docs";
    document.body.innerHTML = `<nav>Home About</nav><main>The answer is 42.</main>`;
    // jsdom implements innerText as textContent, which is close enough for the selection this asserts.
    const page = readPageText();
    expect(page.text).toContain("42");
    expect(page.text).not.toContain("About");
});
