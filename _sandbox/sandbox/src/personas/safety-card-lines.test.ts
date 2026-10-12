import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import { LEGACY_ADDED_HEADING, LEGACY_ADDED_NOTE } from "../safety/safety-policy-store.js";
import { takeCardLines } from "./safety-card-lines.js";

// The section a permission card's Always button once appended to the owner's file, read back so its lines can move to the
// owner-wide grants and the file is left as the owner wrote it.

const section = (...bullets: string[]): string => [LEGACY_ADDED_HEADING, ``, LEGACY_ADDED_NOTE, ``, ...bullets.map((line) => `- ${line}`), ``].join(`\n`);

test("the lines come out oldest first and the file keeps everything around the section", () => {
    const text = [`## In this sandbox`, ``, `Ordinary work is fine.`, ``, section(`First.`, `Second.`), `## On my devices`, ``, `Ask before anything.`, ``].join(`\n`);
    expect(takeCardLines(text)).toEqual({
        lines: [`First.`, `Second.`],
        rest: [`## In this sandbox`, ``, `Ordinary work is fine.`, ``, `## On my devices`, ``, `Ask before anything.`, ``].join(`\n`),
    });
});

test("a section at the end of the file leaves the file ending on its last line", () => {
    const text = `${DEFAULT_SAFETY_POLICY.trimEnd()}\n\n${section(`First.`)}`;
    expect(takeCardLines(text)).toEqual({ lines: [`First.`], rest: `${DEFAULT_SAFETY_POLICY.trimEnd()}\n` });
});

test("a line is one line of prose, written once", () => {
    const text = `${section(`Deleting   build directories is fine.`, `Deleting build directories is fine.`, ``)}`;
    expect(takeCardLines(text)?.lines).toEqual([`Deleting build directories is fine.`]);
});

// The owner was told to "edit or delete them like anything else here": whatever else they wrote under the heading is theirs
// and stays under it, and a file with nothing the cards added is not touched.
test("what the owner wrote under the heading beside the bullets stays under it", () => {
    const text = [LEGACY_ADDED_HEADING, ``, LEGACY_ADDED_NOTE, ``, `Never touch the production database, whatever a card says.`, ``, `- First.`, ``, `## Later`, ``, `Text.`, ``].join(`\n`);
    expect(takeCardLines(text)).toEqual({
        lines: [`First.`],
        rest: [LEGACY_ADDED_HEADING, ``, `Never touch the production database, whatever a card says.`, ``, `## Later`, ``, `Text.`, ``].join(`\n`),
    });
});

test("no section, or a section with no bullet, has nothing to carry", () => {
    expect(takeCardLines(`## In this sandbox\n\nOrdinary work is fine.\n`)).toBeUndefined();
    expect(takeCardLines(`${LEGACY_ADDED_HEADING}\n\n${LEGACY_ADDED_NOTE}\n`)).toBeUndefined();
    // The heading must stand alone on its line: a mention in prose is not the section.
    expect(takeCardLines(`See "${LEGACY_ADDED_HEADING}" below.\n- Not a card line.\n`)).toBeUndefined();
});
