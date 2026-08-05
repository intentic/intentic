import { expect, test } from "vitest";

import { validateOutputs } from "./outputs-check.js";

test("accepts outputs declared for the kind", () => {
    expect(() => validateOutputs("forgejo", { url: "u", internalUrl: "i", runnerToken: "t" }, "host-git")).not.toThrow();
});

test("rejects an undeclared output", () => {
    expect(() => validateOutputs("forgejo", { bogus: "x" }, "host-git")).toThrow(/unknown output "bogus"/);
});

test("a kind with no outputs rejects any produced output", () => {
    expect(() => validateOutputs("ci", { anything: 1 }, "my-app.production-ci")).toThrow();
});
