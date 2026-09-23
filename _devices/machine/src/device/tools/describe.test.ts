import { LONG_OUTAGE_ATTEMPTS } from "@intentic/sandbox-contract/peer-dial";
import type { LinkReading } from "../config.js";
import { linkFacts } from "./describe.js";

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
