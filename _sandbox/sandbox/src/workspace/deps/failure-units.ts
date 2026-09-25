import type { MainlineFailure } from "@intentic/sandbox-contract";

// A FAILURE UNIT is one line a land check's report names (failure-units.mjs, land-tiers.mjs in this repository): a
// failing test as `<task> <path> › <name>`, a type error or lint finding as `<task> <path>: <message>`, a whole failed
// task as its id. Read here, once, for the router (which package a failure sits in) and for the editor (what to show).

// The first repository path a unit names; a task id (`@scope/name#task`) is a package name, never a path.
export const pathOfUnit = (unit: string): string | undefined =>
    unit
        .split(/\s+/)
        .map((word) => word.replace(/:$/, ""))
        .find((word) => word.includes("/") && !word.includes("#") && !word.startsWith("@"));

// A unit as a reader scans it: a failing test by its own name, since its location would spend a narrow column on the
// path; anything else whole. The path rides beside it either way.
export const failureOf = (unit: string): MainlineFailure => {
    const path = pathOfUnit(unit);
    const cut = unit.indexOf(" › ");
    const name = cut === -1 ? "" : unit.slice(cut + " › ".length).trim();
    return { name: name === "" ? unit : name, ...(path === undefined ? {} : { path }) };
};
