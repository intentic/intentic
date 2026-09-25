import { type Finding, fnvDigest, type MainlineFailure } from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";

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

// A unit as a Finding (contract, FindingSchema): what a land check's red owes, in the one shape every red keeps. The next
// land check measures it again, so it is always recheckable; its id is its text's digest, so the same failure found by a
// later run is the same finding.
export const LAND_CHECK_SOURCE = "land-check";
export const findingOfUnit = (unit: string): Finding => {
    const path = pathOfUnit(unit);
    return { id: fnvDigest(unit), source: LAND_CHECK_SOURCE, text: unit, ...opt("path", path), recheckable: true };
};
