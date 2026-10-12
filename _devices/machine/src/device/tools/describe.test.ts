import { LONG_OUTAGE_ATTEMPTS } from "@intentic/sandbox-contract/peer-dial";
import type { LinkReading } from "../config.js";
import { agentLines, linkFacts } from "./describe.js";
import { icOverrides } from "./ic-binary.js";

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

// (2026-10-07) A setup script's leftover IC_URL put a three-week-old ic on rog, and finding which ic answered took a dozen
// calls: describe names it, its version and file time, and what in the agent's environment steers it.
test("describe says which ic answers, from where and how old, what overrides steer it, and why the agent before ended", () => {
    const lines = agentLines(
        { path: "C:\\Users\\me\\.intentic\\ic\\bin\\ic.exe", version: "1.380.0", modified: "2026-09-16T10:00:00.000Z" },
        ["IC_URL=http://localhost:4321/desktop"],
        { version: "1.401.0", startedAt: "2026-10-11T08:00:00.000Z", previous: "the agent before this one (pid 4) ended: it was stopped." },
    );
    expect(lines).toEqual([
        "Agent: intentic-machine 1.401.0, running since 2026-10-11T08:00:00.000Z; its own logs are read with device_logs",
        "Before it: the agent before this one (pid 4) ended: it was stopped.",
        "ic: 1.380.0 at C:\\Users\\me\\.intentic\\ic\\bin\\ic.exe (written 2026-09-16T10:00:00.000Z)",
        "Overrides in the agent's environment: IC_URL=http://localhost:4321/desktop",
    ]);
    expect(agentLines(undefined, [], { version: "1.401.0" })[1]).toMatch(/^ic: none answers here/);
});

test("the overrides shown are ic's and intentic's own, sorted, with a secret's value shown only by its length", () => {
    expect(icOverrides({ PATH: "/bin", INTENTIC_LOG_DIR: "/l", IC_URL: "http://x", INTENTIC_SETUP_TOKEN: "abcdef", ICONS: "no" })).toEqual([
        "IC_URL=http://x",
        "INTENTIC_LOG_DIR=/l",
        "INTENTIC_SETUP_TOKEN=<6 characters>",
    ]);
});
