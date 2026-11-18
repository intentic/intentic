import { getPriority } from "node:os";
import { atNormalPriority } from "./priority.js";

// Raising a keyring Task Scheduler started below normal is Windows' alone, and never lowers a process.

test("does nothing off Windows, where raising a priority needs a privilege the keyring lacks", () => {
    expect(atNormalPriority(undefined, "linux")).toBe(false);
    expect(atNormalPriority(process.pid, "darwin")).toBe(false);
});

test("never lowers a process's priority", () => {
    const before = getPriority();
    atNormalPriority(undefined, "win32");
    expect(getPriority()).toBeLessThanOrEqual(before);
});

test("leaves a process it cannot reach as it is", () => {
    expect(atNormalPriority(2 ** 22 + 12_345, "win32")).toBe(false);
});
