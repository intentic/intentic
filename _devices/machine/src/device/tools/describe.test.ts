import { LONG_OUTAGE_ATTEMPTS } from "@intentic/sandbox-contract/peer-dial";
import { expect, test } from "vitest";
import type { LinkReading } from "../config.js";
import { distrosFrom, linkFacts } from "./describe.js";

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

// What a sandbox is told about the links this machine holds to OTHER sandboxes. Counts and an age, never addresses:
// they belong to the same owner but not to the sandbox asking, and the count is all its card needs to offer the drop.
const down = (failures: number, since: number): LinkReading => ({ state: "connecting", outage: { failures, since } });

test("reports how many links are held and how many have stopped being reachable, and nothing else", () => {
    expect(
        linkFacts({
            "https://a.example": { state: "open" },
            "https://b.example": down(LONG_OUTAGE_ATTEMPTS, 1_700_000_500_000),
            "https://c.example": down(LONG_OUTAGE_ATTEMPTS + 900, 1_700_000_000_000),
        }),
    ).toEqual({ total: 3, unreachable: 2, unreachableSince: 1_700_000_000_000 });
});

// The same line the dial loop draws to stop treating silence as a restart: below it, a sandbox is restarting and
// nobody should be offered a button that throws its link away.
test("a link that has only just stopped answering is not yet unreachable", () => {
    expect(linkFacts({ "https://a.example": down(LONG_OUTAGE_ATTEMPTS - 1, 1_700_000_000_000) })).toEqual({ total: 1, unreachable: 0 });
});

// Not the same fact as "none unreachable": an agent that has not stamped yet, or is too old to, has said nothing,
// and a card that read that as tidy would be answering on no evidence.
test("says nothing at all when the agent has not stamped its links", () => {
    expect(linkFacts(undefined)).toBeUndefined();
});
