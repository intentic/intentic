import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { DEFINITION_SOURCES, DEFINITION_WORKSPACE } from "./definition.js";

/* THE SAME GUARD AS THE STATE-COVERAGE PAIR, one level up: every VERSIONED config manifest must be placed
 * relative to the definition format, either read into a typed section (DEFINITION_SOURCES) or declared as
 * riding the workspace repo (DEFINITION_WORKSPACE) with a note saying how it lands there. `versioned` is the
 * right population because it is already the answer to "is this configuration a human reviews", which is
 * exactly the class a definition exists to express — and, since `[workspace]`, exactly the class the workspace
 * repo tracks, which is why every one of them now travels and the only open question is by which door.
 *
 * Without this, the failure mode is silence: a config surface added next quarter simply never appears in
 * anyone's sandbox.toml, and nothing anywhere says whether that was a decision or an omission. With it,
 * adding a versioned config file is a red test until someone answers the question in one visible list. */

const placed = new Set([...DEFINITION_SOURCES, ...DEFINITION_WORKSPACE.map((entry) => entry.path)]);

test("every versioned config manifest is either a definition source or carried by the workspace repo", () => {
    const unplaced = WORKSPACE_STATE_FILES.filter(
        (file) => file.path.startsWith(".intentic/config/") && file.versioned === true && !placed.has(file.path),
    ).map((file) => file.path);
    expect(
        unplaced.toSorted(),
        "Place these in portability/definition.ts: DEFINITION_SOURCES if deriveDefinition reads them into a section, else DEFINITION_WORKSPACE with a note saying how the file lands on a target.",
    ).toEqual([]);
});

test("every placed path is a real workspace-state entry", () => {
    // The other direction: a list entry left behind after its manifest was renamed would keep vouching for a
    // file that can no longer exist, which is how hand-kept lists rot.
    const known = new Set(WORKSPACE_STATE_FILES.map((file) => file.path));
    const stale = [...placed].filter((path) => !known.has(path));
    expect(stale.toSorted(), "These name no WORKSPACE_STATE_FILES entry — drop them or fix the path.").toEqual([]);
});

test("no path is both a source and workspace-carried", () => {
    // A source is ALSO tracked in the workspace repo, of course — the point of the split is which door the
    // definition speaks about it through, and naming one path twice makes that answer ambiguous.
    const doubled = DEFINITION_SOURCES.filter((path) => DEFINITION_WORKSPACE.some((entry) => entry.path === path));
    expect(doubled).toEqual([]);
});
