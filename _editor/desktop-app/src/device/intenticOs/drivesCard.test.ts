import type { OsDriveImportEnd } from "../../osSettings";
import { copyEndOf, copySaidOf, copyTargetsOf, driveNameOf, foldCopy, folderOf, folderRefused, placeOf, shareOf } from "./drivesCard";
import { example, GOLDEN } from "./golden.testing";

// The drives as the card reads them: what a person calls each, the sandboxes it can go into, the folder typed for it, a
// copy's progress as every window hears it, where it went and how it ended. The drives are the contract's own example of
// `ic os drives list`: a named stick, a big disk, a stick with no name, and a camera's memory card.

const drives = example(GOLDEN.drives).drives;
const stick = example(drives, 0);

const END: OsDriveImportEnd = {
    device: `/dev/sda1`,
    sandbox: `work`,
    outcome: `done`,
    copied: example(GOLDEN.driveImport),
    code: 0,
    timedOut: false,
    reason: null,
    log: `/logs/import.log`,
    ran: true,
};

describe(`a drive's name`, () => {
    it(`is its label, else its model, else none for the card to say what kind`, () => {
        expect(drives.map(driveNameOf)).toEqual([
            `KINGSTON`,
            `Photos`,
            `Flash Disk`,
            `CANON_DC`,
        ]);
        expect(driveNameOf({ ...stick, label: ` `, model: null })).toBeUndefined();
    });
});

describe(`where a drive can go`, () => {
    it(`is each sandbox on this computer, once, by its name`, () => {
        expect(
            copyTargetsOf([
                { slug: `work`, name: `Work` },
                { slug: `alpha`, name: undefined },
                { slug: `work`, name: `Work again` },
                { slug: `photos`, name: ` ` },
            ]),
        ).toEqual([
            { slug: `alpha`, name: `alpha` },
            { slug: `photos`, name: `photos` },
            { slug: `work`, name: `Work` },
        ]);
    });

    it(`is a folder inside its /work where one is typed, and never one out of it`, () => {
        expect(folderOf(``)).toBeUndefined();
        expect(folderOf(`  /Photos/2026/ `)).toBe(`Photos/2026`);
        expect(folderRefused(``)).toBe(false);
        expect(folderRefused(`Photos/2026`)).toBe(false);
        expect(folderRefused(`/Photos/`)).toBe(false);
        expect(folderRefused(`../etc`)).toBe(true);
        expect(folderRefused(`a//b`)).toBe(true);
        expect(folderRefused(`-rf`)).toBe(true);
    });

    it(`is said as a place in the sandbox`, () => {
        expect(placeOf(`/work/Imports/KINGSTON-2026-10-16`)).toBe(`Imports › KINGSTON-2026-10-16`);
        expect(placeOf(`/work/Photos/2026/`)).toBe(`Photos › 2026`);
        expect(placeOf(`/work`)).toBe(``);
    });
});

describe(`a copy`, () => {
    it(`is followed from its start through its progress to its end`, () => {
        const started = foldCopy(undefined, { kind: `started`, device: `/dev/sda1`, sandbox: `work` });
        expect(started).toEqual({ device: `/dev/sda1`, sandbox: `work`, bytes: 0, total: 0 });
        expect(started === undefined ? undefined : shareOf(started)).toBeUndefined();
        const halfway = foldCopy(started, { kind: `progress`, device: `/dev/sda1`, sandbox: `work`, ...example(GOLDEN.driveImportProgress).progress });
        expect(halfway).toEqual({ device: `/dev/sda1`, sandbox: `work`, bytes: 61728394, total: 123456789 });
        expect(halfway === undefined ? undefined : shareOf(halfway)).toBeCloseTo(0.5, 2);
        expect(foldCopy(halfway, { kind: `exit`, ...END })).toBeUndefined();
        expect(copyEndOf({ kind: `exit`, ...END })).toEqual(END);
        expect(copyEndOf({ kind: `started`, device: `/dev/sda1`, sandbox: `work` })).toBeUndefined();
    });

    it(`heard part way through is drawn from its progress, and another's end leaves it`, () => {
        expect(foldCopy(undefined, { kind: `progress`, device: `/dev/sdb1`, sandbox: `photos`, bytes: 5, total: 4 })).toEqual({
            device: `/dev/sdb1`,
            sandbox: `photos`,
            bytes: 5,
            total: 4,
        });
        expect(shareOf({ device: `/dev/sdb1`, sandbox: `photos`, bytes: 5, total: 4 })).toBe(1);
        const going = { device: `/dev/sdb1`, sandbox: `photos`, bytes: 1, total: 4 };
        // A refused copy of another drive ends, and this one goes on.
        expect(foldCopy(going, { kind: `exit`, ...END, outcome: `busy`, ran: false })).toEqual(going);
    });

    it(`ended says it was copied, did not fit, failed, or was refused; a stop says nothing`, () => {
        expect(copySaidOf(END)).toBe(`copied`);
        expect(copySaidOf({ ...END, outcome: `noRoom`, copied: null })).toBe(`noRoom`);
        expect(copySaidOf({ ...END, outcome: `failed` })).toBe(`failed`);
        expect(copySaidOf({ ...END, outcome: `busy`, ran: false })).toBe(`busy`);
        expect(copySaidOf({ ...END, outcome: `notOs` })).toBe(`notOs`);
        expect(copySaidOf({ ...END, outcome: `stopped` })).toBeUndefined();
        expect(copySaidOf(undefined)).toBeUndefined();
    });
});
