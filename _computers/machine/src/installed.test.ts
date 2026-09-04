import { describe, expect, it, vi } from "vitest";
import { buildOf } from "./installed.js";

/* WHICH BUILD IS INSTALLED, as opposed to which one is asking — the distinction the machine report was missing
 * and the reason a computer could be updated and go on serving a months-old agent with every readable version
 * agreeing on the old number.
 *
 * The three cases are three different machines, and only the middle one costs anything. */
describe("buildOf", () => {
    const never = (): string | undefined => {
        throw new Error("the file should not have been asked");
    };

    it("answers its own version, without asking, while the file it started from is unchanged", () => {
        expect(buildOf("95:1700", { at: "95:1700", ours: true }, "1.240.0", never)).toBe("1.240.0");
    });

    /* THE CASE THIS EXISTS FOR: the binary was replaced under a running process, so what we compiled as is the
     * build SERVING, not the build installed, and the only way to learn the second is to run the file. */
    it("asks the file when it has been swapped under us", () => {
        const ask = vi.fn(() => "1.240.0");
        expect(buildOf("96:1800", { at: "95:1700", ours: true }, "1.233.0", ask)).toBe("1.240.0");
        expect(ask).toHaveBeenCalledWith("96:1800");
    });

    // A dev run, or a binary somebody is trying out from Downloads: our own version says nothing about what is
    // installed on this machine, however unchanged that file is.
    it("asks the file when this process is not the installed agent", () => {
        const ask = vi.fn(() => "1.240.0");
        expect(buildOf("95:1700", { at: "95:1700", ours: false }, "0.0.0", ask)).toBe("1.240.0");
        expect(ask).toHaveBeenCalledOnce();
    });

    // Nothing at the install path at all: the agent that answered is the only one this machine has, which is
    // what this field said before it was about the file — so the row keeps the version it always showed.
    it("answers its own version when there is no installed file to read", () => {
        expect(buildOf(undefined, { at: undefined, ours: false }, "1.240.0", never)).toBe("1.240.0");
    });

    // A file that cannot state a version (not an agent, too old for the command) is not a version: the readers
    // treat an absent build as "not known", never as a number to compare.
    it("carries the file's silence rather than inventing a version", () => {
        expect(buildOf("96:1800", { at: "95:1700", ours: true }, "1.233.0", () => undefined)).toBeUndefined();
    });
});
