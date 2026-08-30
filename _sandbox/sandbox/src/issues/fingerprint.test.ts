import type { IssueReport } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { culpritOf, deHash, fingerprintOf, frameOf, framesOf, messageClass, titleOf } from "./fingerprint.js";

/* THE TESTS THAT MATTER HERE ARE THE ONES ABOUT MONEY. Every case below is a way one bug could have read as
 * many bugs (a wake each, billed to the owner) or many bugs as one (a real regression buried under a count),
 * so they are written as pairs: two reports that must group, or two that must not. */

const crash = (over: Partial<IssueReport> = {}): IssueReport => ({ kind: "crash", message: "TypeError: x is not a function", ...over });

// One deploy later, the same crash arrives from a bundle with a different hash, at a different line, from a
// browser that renders stacks in the other dialect. Nothing about the BUG changed, so nothing about the group
// may change either: this is the case that decides whether an inbox is readable after a week of deploys.
test("one crash groups across builds, line numbers, hosts and stack dialects", () => {
    const chrome = crash({
        stack: [
            "TypeError: x is not a function",
            "    at doThing (https://shop.example/assets/index-DdSk2Fs1.js:2:14403)",
            "    at onClick (https://shop.example/assets/index-DdSk2Fs1.js:2:9981)",
        ].join("\n"),
    });
    const firefoxNextDeployBehindACdn = crash({
        stack: [
            "doThing@https://cdn.example/assets/index-Bq91xLm2.js:7:220",
            "onClick@https://cdn.example/assets/index-Bq91xLm2.js:7:88",
        ].join("\n"),
    });
    expect(fingerprintOf("bugs", chrome, "a")).toBe(fingerprintOf("bugs", firefoxNextDeployBehindACdn, "b"));
});

// The other direction, and the more dangerous failure: over-eager normalization that files a genuinely new
// regression under an existing group is a bug nobody is ever told about.
test("different code paths, different messages and different intakes stay apart", () => {
    const here = crash({ stack: "    at doThing (https://s/assets/app.js:1:1)" });
    const elsewhere = crash({ stack: "    at otherThing (https://s/assets/app.js:1:1)" });
    const otherMessage = crash({ message: "TypeError: y is not a function", stack: "    at doThing (https://s/assets/app.js:1:1)" });
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("bugs", elsewhere, "a"));
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("bugs", otherMessage, "a"));
    // Two products, one shared library, one message: two inboxes.
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("other-site", here, "a"));
});

// The ids in a message are the day's values, not the bug. Grouping on them turns one broken endpoint into one
// issue per row it was asked for.
test("values inside a message do not split it", () => {
    const a = crash({ message: `Failed to load "/api/users/8813" (request 3f2a9c1b-1111-4222-8333-abcdefabcdef)` });
    const b = crash({ message: `Failed to load "/api/users/9204" (request 7d1e0000-2222-4333-9444-fedcbafedcba)` });
    expect(fingerprintOf("bugs", a, "x")).toBe(fingerprintOf("bugs", b, "x"));
});

/* A stackless crash is the `window.onerror` cross-origin case ("Script error." and nothing else) and every old
 * browser. Falling back to the page is what stops those collapsing into one useless mega-issue. */
test("a stackless crash falls back to the page, not to one global group", () => {
    const checkout = crash({ message: "Script error.", url: "https://shop.example/checkout?step=2" });
    const checkoutAgain = crash({ message: "Script error.", url: "https://shop.example/checkout?step=9#top" });
    const home = crash({ message: "Script error.", url: "https://shop.example/" });
    expect(fingerprintOf("bugs", checkout, "a")).toBe(fingerprintOf("bugs", checkoutAgain, "b"));
    expect(fingerprintOf("bugs", checkout, "a")).not.toBe(fingerprintOf("bugs", home, "c"));
});

// Two people describing one annoyance in their own words are two things to read. A count of 2 on the first
// person's sentence would hide the second person's entirely.
test("written reports never group, even when identical; the host's own fingerprint always does", () => {
    const report: IssueReport = { kind: "report", message: "Feedback", description: "the button does nothing" };
    expect(fingerprintOf("bugs", report, "first")).not.toBe(fingerprintOf("bugs", report, "second"));

    const pinned = crash({ fingerprint: "checkout-total", stack: "    at a (https://s/x.js:1:1)" });
    const pinnedElsewhere = crash({ fingerprint: "checkout-total", message: "totally different", stack: "    at b (https://s/y.js:9:9)" });
    expect(fingerprintOf("bugs", pinned, "a")).toBe(fingerprintOf("bugs", pinnedElsewhere, "b"));
});

test("build hashes come out of filenames and ordinary names survive", () => {
    expect(deHash("/assets/index-DdSk2Fs1.js")).toBe("/assets/index.js");
    expect(deHash("/assets/main.a1b2c3d4.chunk.js")).toBe("/assets/main.chunk.js");
    expect(deHash("/js/polyfills-legacy.js")).toBe("/js/polyfills-legacy.js");
    expect(deHash("/js/bundle2.js")).toBe("/js/bundle2.js");
    // A basename that is nothing BUT a hash keeps its name: an empty file component would group every such
    // bundle together, which is the opposite of what the hash stripping is for.
    expect(deHash("/assets/a1b2c3d4e5.js")).toBe("/assets/a1b2c3d4e5.js");
});

test("frames keep the function and the path, and drop position, origin and query", () => {
    expect(frameOf("    at doThing (https://site.example/assets/app.js:2:14403)")).toBe("doThing@/assets/app.js");
    expect(frameOf("doThing@https://site.example/assets/app.js:2:14403")).toBe("doThing@/assets/app.js");
    // V8's anonymous frame: no function, still a location.
    expect(frameOf("    at https://site.example/assets/app.js:2:1")).toBe("@/assets/app.js");
    // The first line of a V8 stack is the message, not a frame.
    expect(frameOf("TypeError: x is not a function")).toBeUndefined();
    expect(frameOf("   ")).toBeUndefined();
    expect(framesOf("TypeError: nope\n    at a (https://s/x.js:1:1)\n    at b (https://s/y.js:2:2)")).toEqual(["a@/x.js", "b@/y.js"]);
});

// "It broke in react-dom" is true of half the crashes on the internet, so the row would say nothing.
test("the culprit shown is the site's own code, not the framework it went through", () => {
    const stack = ["    at flush (https://s/node_modules/react-dom/index.js:1:1)", "    at MyCart (https://s/src/Cart.tsx:14:3)"].join("\n");
    expect(culpritOf(stack)).toBe("MyCart@/src/Cart.tsx");
    // Everything vendor: the honest answer is the real top frame rather than nothing.
    expect(culpritOf("    at flush (https://s/node_modules/react-dom/index.js:1:1)")).toBe("flush@/node_modules/react-dom/index.js");
    expect(culpritOf(undefined)).toBeUndefined();
});

test("the message class keeps the sentence and loses the values", () => {
    expect(messageClass(`Cannot read "name" of undefined at 14:02`)).toBe(`Cannot read "<v>" of undefined at #:#`);
});

// A written report is listed by what the person WROTE; a crash by what the browser said, ids and all, because
// that is the sentence the reader is going to search their logs for.
test("titles read as the thing itself", () => {
    expect(titleOf({ kind: "report", message: "Feedback", description: "  the\n  button   does nothing " })).toBe("the button does nothing");
    expect(titleOf(crash({ message: "TypeError: x is not a function" }))).toBe("TypeError: x is not a function");
    expect(titleOf({ kind: "report", message: "Feedback", description: "   " })).toBe("Feedback");
});
