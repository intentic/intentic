import { expect, test } from "vitest";
import { childPids } from "./workload-priority.js";

test("childPids accepts procfs whitespace and rejects anything that is not a positive integer pid", () => {
    expect(childPids(" 12  45\n91 ")).toEqual([12, 45, 91]);
    expect(childPids("0 -1 nope 3.5")).toEqual([]);
    expect(childPids("\n")).toEqual([]);
});
