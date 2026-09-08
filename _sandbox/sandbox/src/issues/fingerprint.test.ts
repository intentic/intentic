import type { IssueReport } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { culpritOf, deHash, fingerprintOf, frameOf, framesOf, messageClass, titleOf } from "./fingerprint.js";

// Each case pins one way a bug could over-count (billed once per false split) or under-count (buried in another issue's
// group), written as must-group / must-not-group pairs.

const crash = (over: Partial<IssueReport> = {}): IssueReport => ({ kind: "crash", message: "TypeError: x is not a function", ...over });

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

test("different code paths, different messages and different intakes stay apart", () => {
    const here = crash({ stack: "    at doThing (https://s/assets/app.js:1:1)" });
    const elsewhere = crash({ stack: "    at otherThing (https://s/assets/app.js:1:1)" });
    const otherMessage = crash({ message: "TypeError: y is not a function", stack: "    at doThing (https://s/assets/app.js:1:1)" });
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("bugs", elsewhere, "a"));
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("bugs", otherMessage, "a"));
    expect(fingerprintOf("bugs", here, "a")).not.toBe(fingerprintOf("other-site", here, "a"));
});

test("values inside a message do not split it", () => {
    const a = crash({ message: `Failed to load "/api/users/8813" (request 3f2a9c1b-1111-4222-8333-abcdefabcdef)` });
    const b = crash({ message: `Failed to load "/api/users/9204" (request 7d1e0000-2222-4333-9444-fedcbafedcba)` });
    expect(fingerprintOf("bugs", a, "x")).toBe(fingerprintOf("bugs", b, "x"));
});

// "Script error." is the window.onerror cross-origin / old-browser stackless case.
test("a stackless crash falls back to the page, not to one global group", () => {
    const checkout = crash({ message: "Script error.", url: "https://shop.example/checkout?step=2" });
    const checkoutAgain = crash({ message: "Script error.", url: "https://shop.example/checkout?step=9#top" });
    const home = crash({ message: "Script error.", url: "https://shop.example/" });
    expect(fingerprintOf("bugs", checkout, "a")).toBe(fingerprintOf("bugs", checkoutAgain, "b"));
    expect(fingerprintOf("bugs", checkout, "a")).not.toBe(fingerprintOf("bugs", home, "c"));
});

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
    // An all-hash basename keeps its name; stripping it would collapse every such bundle into one.
    expect(deHash("/assets/a1b2c3d4e5.js")).toBe("/assets/a1b2c3d4e5.js");
});

test("frames keep the function and the path, and drop position, origin and query", () => {
    expect(frameOf("    at doThing (https://site.example/assets/app.js:2:14403)")).toBe("doThing@/assets/app.js");
    expect(frameOf("doThing@https://site.example/assets/app.js:2:14403")).toBe("doThing@/assets/app.js");
    // V8's anonymous frame: no function name, still a location.
    expect(frameOf("    at https://site.example/assets/app.js:2:1")).toBe("@/assets/app.js");
    // First line of a V8 stack is the message, not a frame.
    expect(frameOf("TypeError: x is not a function")).toBeUndefined();
    expect(frameOf("   ")).toBeUndefined();
    expect(framesOf("TypeError: nope\n    at a (https://s/x.js:1:1)\n    at b (https://s/y.js:2:2)")).toEqual(["a@/x.js", "b@/y.js"]);
});

test("the culprit shown is the site's own code, not the framework it went through", () => {
    const stack = ["    at flush (https://s/node_modules/react-dom/index.js:1:1)", "    at MyCart (https://s/src/Cart.tsx:14:3)"].join("\n");
    expect(culpritOf(stack)).toBe("MyCart@/src/Cart.tsx");
    // All frames vendor: falls back to the real top frame rather than nothing.
    expect(culpritOf("    at flush (https://s/node_modules/react-dom/index.js:1:1)")).toBe("flush@/node_modules/react-dom/index.js");
    expect(culpritOf(undefined)).toBeUndefined();
});

test("the message class keeps the sentence and loses the values", () => {
    expect(messageClass(`Cannot read "name" of undefined at 14:02`)).toBe(`Cannot read "<v>" of undefined at #:#`);
});

// A written report's title is what the person wrote; a crash's is the browser's own message, ids included.
test("titles read as the thing itself", () => {
    expect(titleOf({ kind: "report", message: "Feedback", description: "  the\n  button   does nothing " })).toBe("the button does nothing");
    expect(titleOf(crash({ message: "TypeError: x is not a function" }))).toBe("TypeError: x is not a function");
    expect(titleOf({ kind: "report", message: "Feedback", description: "   " })).toBe("Feedback");
});
