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

/* `throw` carries anything at all, and the string case and the plain-object case are both common in the wild (a
 * rejected fetch wrapper, a framework throwing a config bag). None of those has a stack, and all of them have
 * to group on SOMETHING rather than on the word "undefined". */
test("anything thrown becomes a readable report", () => {
    expect(reportFrom(new TypeError("x is not a function"))).toMatchObject({ kind: "crash", message: "TypeError: x is not a function" });
    expect(reportFrom(new TypeError("boom")).stack).toContain("TypeError");
    expect(reportFrom("just a string")).toEqual({ kind: "crash", message: "just a string" });
    expect(reportFrom({ code: 42 })).toEqual({ kind: "crash", message: `{"code":42}` });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(reportFrom(cyclic).message).toBe("Non-error thrown (object)");
    // `throw null` is real, and JSON.stringify would turn it into the string "null" — a message that says
    // nothing and groups every one of them together.
    expect(reportFrom(null).message).toBe("Non-error thrown (null)");
    expect(reportFrom(undefined).message).toBe("Non-error thrown (undefined)");
});

test("an uncaught error is captured", () => {
    const caught = armed();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new RangeError("out of range") }));
    expect(caught).toHaveLength(1);
    expect(caught[0]?.message).toBe("RangeError: out of range");
});

// A 404 on an image arrives on the same `error` event as a real throw. Reporting those fills the inbox with
// other people's CDNs.
test("a resource that failed to load is not a crash", () => {
    const caught = armed();
    const image = document.createElement("img");
    document.body.append(image);
    image.dispatchEvent(new ErrorEvent("error", { message: "" }));
    expect(caught).toEqual([]);
});

/* The cross-origin case: a script from another origin without `crossorigin` gives "Script error." and nothing
 * else, in every browser, by design. Still reported, because the daemon groups a stackless crash by the PAGE,
 * so it arrives as "something on /checkout throws and we cannot see what" — which is actionable where silence
 * is not. */
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

/* THE ONE THAT PROTECTS SOMEBODY ELSE'S ERROR REPORTING. `window.onerror = …` is a single slot: assigning it
 * unhooks whatever the site had there, and the failure shows up weeks later as their tool going quiet with
 * nothing pointing at us. */
test("the site's own onerror is left alone, and detach removes only ours", () => {
    /* Written through an index because the lint rule that forbids `window.onerror = …` is right about our own
     * code and is exactly what this test is simulating: a SITE that used the legacy single slot, which our
     * addEventListener must not disturb. */
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
    // No `error` object on this one: with our listener gone nothing would consume it, and jsdom reports an
    // unhandled ErrorEvent carrying a real Error as an uncaught exception, failing the run over the test's own
    // probe. A message-only event still proves the point, since our handler reports those too.
    window.dispatchEvent(new ErrorEvent("error", { message: "after" }));
    // Ours is gone; theirs is untouched.
    expect(caught).toHaveLength(1);
    expect(legacy["onerror"]).toBe(theirHandler);
    legacy["onerror"] = null;
});
