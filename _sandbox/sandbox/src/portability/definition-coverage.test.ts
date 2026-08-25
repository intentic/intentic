import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { DEFINITION_EXCLUDED, DEFINITION_SOURCES } from "./definition.js";

/* THE SAME GUARD AS THE STATE-COVERAGE PAIR, one level up: every VERSIONED config manifest must be placed
 * relative to the definition format, either read by the deriver (DEFINITION_SOURCES) or excluded with a
 * stated reason (DEFINITION_EXCLUDED). `versioned` is the right population because it is already the answer
 * to "is this configuration a human reviews", which is exactly the class a definition exists to express.
 *
 * Without this, the failure mode is silence: a config surface added next quarter simply never appears in
 * anyone's sandbox.toml, and nothing anywhere says whether that was a decision or an omission. With it,
 * adding a versioned config file is a red test until someone answers the question in one visible list. */

const placed = new Set([...DEFINITION_SOURCES, ...DEFINITION_EXCLUDED.map((entry) => entry.path)]);

test("every versioned config manifest is either a definition source or excluded with a reason", () => {
    const unplaced = WORKSPACE_STATE_FILES.filter(
        (file) => file.path.startsWith(".intentic/config/") && file.versioned === true && !placed.has(file.path),
    ).map((file) => file.path);
    expect(
        unplaced.toSorted(),
        "Place these in portability/definition.ts: DEFINITION_SOURCES if deriveDefinition reads them, else DEFINITION_EXCLUDED with a note saying why a definition cannot express them.",
    ).toEqual([]);
});

test("every placed path is a real workspace-state entry", () => {
    // The other direction: a list entry left behind after its manifest was renamed would keep vouching for a
    // file that can no longer exist, which is how hand-kept lists rot.
    const known = new Set(WORKSPACE_STATE_FILES.map((file) => file.path));
    const stale = [...placed].filter((path) => !known.has(path));
    expect(stale.toSorted(), "These name no WORKSPACE_STATE_FILES entry — drop them or fix the path.").toEqual([]);
});

test("no path is both a source and an exclusion", () => {
    const doubled = DEFINITION_SOURCES.filter((path) => DEFINITION_EXCLUDED.some((entry) => entry.path === path));
    expect(doubled).toEqual([]);
});
