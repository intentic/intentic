import { ORPHAN_MIN_AGE_MS, orphanVerdict, registryHold } from "./orphan-checkouts.js";

const DAY_MS = 24 * 60 * 60_000;

test("only a directory the registry answered for, and does not own, past a day untouched is reclaimed", () => {
    expect(ORPHAN_MIN_AGE_MS).toBe(DAY_MS);
    expect(orphanVerdict("owned", 90 * DAY_MS)).toBe("keep");
    expect(orphanVerdict("unknown", 90 * DAY_MS)).toBe("unknown");
    expect(orphanVerdict("unowned", DAY_MS - 1)).toBe("young");
    expect(orphanVerdict("unowned", DAY_MS)).toBe("reclaim");
    // A clock stepped back reads as changed in the future: young, never reclaimed.
    expect(orphanVerdict("unowned", -DAY_MS)).toBe("young");
});

test("the registry answers only when the database was not made again, names some conversation, and loaded some", () => {
    expect(registryHold({ recreated: false, databaseAny: true, loaded: 12 })).toBeUndefined();
    expect(registryHold({ recreated: true, databaseAny: true, loaded: 12 })).toBe("database-recreated");
    expect(registryHold({ recreated: false, databaseAny: false, loaded: 0 })).toBe("database-empty");
    // Rows in the database and none in memory: the registry's load failed, and its silence names nobody.
    expect(registryHold({ recreated: false, databaseAny: true, loaded: 0 })).toBe("registry-empty");
});
