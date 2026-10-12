import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DeviceSwapsSchema } from "./device-swaps.js";

// The rows `ic sandbox swaps --json` answers, as examples: golden/swap-verdicts.json holds each of ic's records and the
// row it gives (the Rust test, _sandbox/ic/src/sandbox/swaps.rs, builds every one; the machine agent's fallback is held
// to the same rows). This is the TS half: the rows ic gives are the rows the contract reads, to the field.

interface VerdictCase {
    readonly name: string;
    readonly record: string;
    readonly now: number;
    readonly swap: Record<string, unknown> | null;
}

// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "swap-verdicts.json"), "utf8")) as {
    readonly slug: string;
    readonly cases: readonly VerdictCase[];
};
const rows: unknown[] = GOLDEN.cases.flatMap((one) => (one.swap === null ? [] : [one.swap]));

test("every row ic gives for the golden records is a row the contract reads, field for field", () => {
    expect(rows.length).toBeGreaterThan(8);
    const read: unknown = DeviceSwapsSchema.parse(rows);
    expect(read).toEqual(rows);
});

test("a row from a newer ic keeps the swap going on: an unknown phase and an extra field still read", () => {
    const [row] = DeviceSwapsSchema.parse([{ slug: "work", phase: "staging", at: 5, cutoverInProgress: false, next: "later" }]);
    expect(row).toMatchObject({ slug: "work", phase: "staging", at: 5, cutoverInProgress: false });
});

test("a field of the wrong type is a field that is not there, but a row without its verdict is no row", () => {
    const [row] = DeviceSwapsSchema.parse([{ slug: "work", phase: "cutover", at: 5, alive: "soon", cutoverInProgress: true }]);
    expect(row?.alive).toBeUndefined();
    expect(DeviceSwapsSchema.safeParse([{ slug: "work", phase: "cutover", at: 5 }]).success).toBe(false);
});
