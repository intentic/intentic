import { DAY_MS } from "../../../system/chore-clock.js";
import { judgeParkedRefs, PARKED_REF_RETENTION_MS } from "../parked-ref-retention.js";

// Pins which archived conversations' parked branches the daily retention deletes: only those the registry knows and
// reports archived longer ago than the retention. Absence from the registry is not proof of anything.

const NOW = Date.parse("2026-10-05T12:00:00Z");

const registry = (entries: Record<string, { archivedAt?: number }>) => (id: string) => entries[id];

test("the retention is ninety days", () => {
    expect(PARKED_REF_RETENTION_MS).toBe(90 * DAY_MS);
});

test("a conversation archived past the retention loses its parked ref; one within it, or live, keeps it", () => {
    const entries = registry({
        old: { archivedAt: NOW - PARKED_REF_RETENTION_MS - DAY_MS },
        recent: { archivedAt: NOW - PARKED_REF_RETENTION_MS + DAY_MS },
        // Un-archived since it was parked: a person's message brought it back, and its next ensure unparks it.
        live: {},
    });
    expect(judgeParkedRefs(["old", "recent", "live"], entries, NOW)).toEqual({ drop: ["old"], kept: ["recent", "live"], unknown: [] });
});

test("a ref whose conversation the registry does not know is left, and counted apart", () => {
    const entries = registry({ old: { archivedAt: NOW - 2 * PARKED_REF_RETENTION_MS } });
    expect(judgeParkedRefs(["old", "stranger"], entries, NOW)).toEqual({ drop: ["old"], kept: [], unknown: ["stranger"] });
});

test("an archive time in the future, from a clock stepped back, is within the retention", () => {
    const entries = registry({ ahead: { archivedAt: NOW + DAY_MS } });
    expect(judgeParkedRefs(["ahead"], entries, NOW)).toEqual({ drop: [], kept: ["ahead"], unknown: [] });
});

test("the boundary itself is kept, and a shorter retention can be asked for", () => {
    const entries = registry({ edge: { archivedAt: NOW - PARKED_REF_RETENTION_MS } });
    expect(judgeParkedRefs(["edge"], entries, NOW).drop).toEqual([]);
    expect(judgeParkedRefs(["edge"], entries, NOW, DAY_MS).drop).toEqual(["edge"]);
});
