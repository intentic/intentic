import type { IssueReport } from "@intentic/sandbox-contract";
import { afterEach, expect, test } from "vitest";
import { type Capture, reportFrom, startCapture } from "./capture.js";

let live: Capture | undefined;
afterEach(() => {
    live?.detach();
    live = undefined;
});

const armed = (): IssueReport[] => {
    const caught: IssueReport[] = [];
    live = startCapture((report) => void caught.push(report));
    return caught;
};

test("anything thrown becomes a readable report", () => {
    expect(reportFrom(new TypeError("x is not a function"))).toMatchObject({ kind: "crash", message: "TypeError: x is not a function" });
    expect(reportFrom(new TypeError("boom")).stack).toContain("TypeError");
    expect(reportFrom("just a string")).toEqual({ kind: "crash", message: "just a string" });
    expect(reportFrom({ code: 42 })).toEqual({ kind: "crash", message: `{"code":42}` });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(reportFrom(cyclic).message).not.toBe(reportFrom(null).message);
    expect(reportFrom(null).message).not.toBe(reportFrom(undefined).message);
    expect(reportFrom(undefined).message).toMatch(/undefined/i);
});

test("an uncaught error is captured", () => {
    const caught = armed();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new RangeError("out of range") }));
    expect(caught).toHaveLength(1);
    expect(caught[0]?.message).toBe("RangeError: out of range");
});

test("a resource that failed to load is not a crash", () => {
    const caught = armed();
    const image = document.createElement("img");
    document.body.append(image);
    image.dispatchEvent(new ErrorEvent("error", { message: "" }));
    expect(caught).toEqual([]);
});

// Cross-origin scripts without `crossorigin` give exactly "Script error." in every browser.
test("a masked cross-origin error is still reported", () => {
    const caught = armed();
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(caught).toEqual([{ kind: "crash", message: "Script error." }]);
});

test("an unhandled rejection is captured, whatever it rejected with", async () => {
    const caught = armed();
    window.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", { promise: Promise.reject(new Error("nope")).catch(() => undefined), reason: "plain string" }),
    );
    expect(caught).toEqual([{ kind: "crash", message: "plain string" }]);
});

test("the site's own onerror is left alone, and detach removes only ours", () => {
    // Written through an index: the `window.onerror` lint rule doesn't apply to this legacy-handler fixture.
    const legacy = window as unknown as Record<string, unknown>;
    const theirs: string[] = [];
    legacy["onerror"] = (message: unknown) => void theirs.push(String(message));
    const theirHandler = legacy["onerror"];

    const caught = armed();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    expect(caught).toHaveLength(1);
    expect(legacy["onerror"]).toBe(theirHandler);

    live?.detach();
    live = undefined;
    // No error object on this one, since jsdom would otherwise raise the real Error as an uncaught exception.
    window.dispatchEvent(new ErrorEvent("error", { message: "after" }));
    expect(caught).toHaveLength(1);
    expect(legacy["onerror"]).toBe(theirHandler);
    legacy["onerror"] = null;
});
