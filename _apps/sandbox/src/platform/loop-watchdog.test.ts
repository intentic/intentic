import { expect, test } from "vitest";
import { parsePressure } from "./loop-watchdog.js";

// Real /proc/pressure shapes: memory/io carry both lines, cpu carries only `some` (a runnable task always
// progresses on something), and a kernel without PSI serves nothing parseable.

test("parses some+full avg10 from a pressure file", () => {
    const text = ["some avg10=1.50 avg60=0.12 avg300=0.08 total=659900661", "full avg10=0.75 avg60=0.12 avg300=0.08 total=572106466"].join("\n");
    expect(parsePressure(text)).toEqual({ some: 1.5, full: 0.75 });
});

test("cpu pressure has no full line — reported as 0, not absent", () => {
    expect(parsePressure("some avg10=2.25 avg60=0.00 avg300=0.10 total=3286364632\n")).toEqual({ some: 2.25, full: 0 });
});

test("unparseable content is undefined, never a throw", () => {
    expect(parsePressure("")).toBeUndefined();
    expect(parsePressure("not a pressure file")).toBeUndefined();
});
