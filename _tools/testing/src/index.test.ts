import { expect, test } from "vitest";
import { unstubbed } from "./index.js";

interface Wide {
    readonly answer: () => string;
    readonly nested: { readonly deep: { readonly reached: () => number } };
    readonly untouched: () => void;
}

test("what the test provides is what the code gets", () => {
    const fake = unstubbed<Wide>("wide", { answer: () => "provided" });
    expect(fake.answer()).toBe("provided");
});

test("an unprovided member names the whole path it was reached by, not the last key", () => {
    const fake = unstubbed<Wide>("wide", {});
    expect(() => fake.nested.deep.reached()).toThrow("wide.nested.deep.reached was called, and this test did not stub it");
});

test("`then` is absent, so awaiting a stand-in does not call it", async () => {
    // A callable `then` would make this value a thenable: `await` resolves it by CALLING the stand-in, which
    // reports the failure as `then was called` from inside the resolution machinery and never as the seam.
    const fake = unstubbed<Wide>("wide", { answer: () => "still here" });
    await expect(Promise.resolve(fake)).resolves.toBe(fake);
});

test("a stand-in inspects as an ordinary value, so an assertion on it reports the assertion", () => {
    const fake = unstubbed<Wide>("wide", {});
    expect(() => JSON.stringify({ fake })).not.toThrow();
});
