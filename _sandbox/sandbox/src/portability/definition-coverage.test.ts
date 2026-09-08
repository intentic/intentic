import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { DEFINITION_SOURCES, DEFINITION_WORKSPACE } from "./definition.js";

// Every versioned config manifest must appear in DEFINITION_SOURCES or DEFINITION_WORKSPACE; otherwise a new config
// surface can go unnoticed, missing from every sandbox.toml with nothing saying whether that's a decision or an
// omission.

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
    // A renamed manifest could leave a stale list entry vouching for a path that no longer exists.
    const known = new Set(WORKSPACE_STATE_FILES.map((file) => file.path));
    const stale = [...placed].filter((path) => !known.has(path));
    expect(stale.toSorted(), "These name no WORKSPACE_STATE_FILES entry — drop them or fix the path.").toEqual([]);
});

test("no path is both a source and workspace-carried", () => {
    // A source is also tracked by the workspace repo; naming it in both lists would make "which door" ambiguous.
    const doubled = DEFINITION_SOURCES.filter((path) => DEFINITION_WORKSPACE.some((entry) => entry.path === path));
    expect(doubled).toEqual([]);
});
