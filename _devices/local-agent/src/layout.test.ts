import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

import {
    ASCII,
    explain,
    fieldLines,
    footnoteLines,
    headingLines,
    itemLines,
    pickLines,
    plainFieldLines,
    plainItemLines,
    planSummary,
    plainRowLine,
    plainSectionLines,
    questionLines,
    quietLine,
    rowLines,
    sectionLines,
    settledLine,
    stopLines,
    UNICODE,
    verdictLines,
    type Footnote,
    type Item,
    type Tone,
} from "./layout.js";

// ic's ui.rs is tested against the same file, so a person sees one layout whichever binary is talking.
interface Case {
    readonly shape: string;
    readonly args: Record<string, unknown>;
    readonly lines: readonly string[];
}
const fixture = JSON.parse(
    readFileSync(join(repoRoot(import.meta.url), "_shared/sandbox-run/src/terminal-layout.fixture.json"), "utf8"),
) as { readonly width: number; readonly cases: readonly Case[] };

const draw = (shape: string, args: Record<string, unknown>): readonly string[] => {
    const pen = { colour: false, glyphs: args["ascii"] === true ? ASCII : UNICODE, width: fixture.width };
    const text = (key: string): string => (args[key] as string | undefined) ?? "";
    const tone = (): Tone => args["tone"] as Tone;
    switch (shape) {
        case "heading":
            return headingLines(pen, text("title"), args["stamp"] as string | undefined, args["scope"] as string | undefined);
        case "planSummary":
            return [planSummary(args["steps"] as number, args["seconds"] as number)];
        case "settled":
            return [settledLine(pen, tone(), args["ordinal"] as number | undefined, text("label"), text("took"))];
        case "verdict":
            return verdictLines(pen, tone(), text("verdict"), text("took"));
        case "footnotes":
            return footnoteLines(pen, args["footnotes"] as Footnote[]);
        case "row":
            return rowLines(pen, tone(), text("name"), text("note"));
        case "plainRow":
            return [plainRowLine(tone(), text("name"), text("note"))];
        case "items":
            return itemLines(pen, args["items"] as Item[]);
        case "plainItems":
            return plainItemLines(args["items"] as Item[]);
        case "section":
            return sectionLines(pen, text("title"));
        case "plainSection":
            return plainSectionLines(text("title"));
        case "fields":
            return fieldLines(pen, args["fields"] as Footnote[]);
        case "plainFields":
            return plainFieldLines(args["fields"] as Footnote[]);
        case "quiet":
            return [quietLine(pen, text("sentence"))];
        case "question":
            return questionLines(pen, text("question"), text("consequence"));
        case "explain":
            return explain(text("headline"), args["problem"] as string | undefined, args["fix"] as string | undefined).split("\n");
        case "stop":
            return stopLines(pen, text("message"));
        case "pick":
            return pickLines(pen, args["items"] as Footnote[]);
        default:
            throw new Error(`the fixture names a shape this renderer does not draw: ${shape}`);
    }
};

describe("the shared terminal layout", () => {
    it.each(fixture.cases.map((entry, at) => [`${at} ${entry.shape}`, entry] as const))("%s", (_name, entry) => {
        expect(draw(entry.shape, entry.args)).toEqual(entry.lines);
    });

    it("never pads a line past its last word", () => {
        for (const entry of fixture.cases) {
            for (const line of entry.lines) {
                expect(line).toBe(line.trimEnd());
            }
        }
    });

    it("keeps every timed line one column short of the edge", () => {
        // One character over and a terminal wraps it, after which a repaint lands a row late.
        for (const entry of fixture.cases.filter((candidate) => candidate.shape === "settled" || candidate.shape === "verdict")) {
            for (const line of entry.lines.filter((candidate) => candidate !== "" && /\d(?:\.\d)?[sm]$/u.test(candidate))) {
                expect([...line]).toHaveLength(fixture.width - 1);
            }
        }
    });
});
