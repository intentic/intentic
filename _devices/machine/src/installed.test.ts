import { describe, expect, it, vi } from "vitest";
import { buildOf } from "./installed.js";

// Which build is installed, as opposed to which one is asking: a device could be updated and keep serving a
// months-old agent while every readable version agreed on the old number. Only the middle case below costs
// anything.
describe("buildOf", () => {
    const never = (): string | undefined => {
        throw new Error("the file should not have been asked");
    };

    it("answers its own version, without asking, while the file it started from is unchanged", () => {
        expect(buildOf("95:1700", { at: "95:1700", ours: true }, "1.240.0", never)).toBe("1.240.0");
    });

    // The case this exists for: the binary was replaced under a running process, so what we compiled as is the
    // build serving, not the build installed, and the only way to learn the latter is to run the file.
    it("asks the file when it has been swapped under us", () => {
        const ask = vi.fn(() => "1.240.0");
        expect(buildOf("96:1800", { at: "95:1700", ours: true }, "1.233.0", ask)).toBe("1.240.0");
        expect(ask).toHaveBeenCalledWith("96:1800");
    });

    // A dev run, or a binary from Downloads: our own version says nothing about what is installed on this machine.
    it("asks the file when this process is not the installed agent", () => {
        const ask = vi.fn(() => "1.240.0");
        expect(buildOf("95:1700", { at: "95:1700", ours: false }, "0.0.0", ask)).toBe("1.240.0");
        expect(ask).toHaveBeenCalledOnce();
    });

    // Nothing at the install path at all: the agent that answered is the only one this machine has, so the row
    // keeps the version it always showed.
    it("answers its own version when there is no installed file to read", () => {
        expect(buildOf(undefined, { at: undefined, ours: false }, "1.240.0", never)).toBe("1.240.0");
    });

    // A file that cannot state a version is not a version: readers treat an absent build as "not known", never as
    // a number to compare.
    it("carries the file's silence rather than inventing a version", () => {
        expect(buildOf("96:1800", { at: "95:1700", ours: true }, "1.233.0", () => undefined)).toBeUndefined();
    });
});
