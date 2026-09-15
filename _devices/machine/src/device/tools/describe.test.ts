import { expect, test } from "vitest";
import { distrosFrom } from "./describe.js";

// `wsl -l -q` is the one listing that names distros the way `in: "wsl:<name>"` must spell them; what it prints has
// varied by build, so the reader is pinned against both shapes.

test("reads one distro per line", () => {
    expect(distrosFrom("Arch\r\nUbuntu-22.04\r\n")).toEqual(["Arch", "Ubuntu-22.04"]);
});

// Older wsl.exe prints UTF-16 regardless of the console, which a UTF-8 decode turns into NUL-interleaved text.
test("cleans the UTF-16 noise an older wsl.exe prints", () => {
    expect(distrosFrom("A\0r\0c\0h\0\r\0\n\0")).toEqual(["Arch"]);
});

test("reads nothing from a machine with no distros", () => {
    expect(distrosFrom("")).toEqual([]);
    expect(distrosFrom("\r\n\r\n")).toEqual([]);
});
