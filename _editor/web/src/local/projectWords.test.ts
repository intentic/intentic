import { cautionSentence, copyWeight, refusalSentence, stageHeadline } from "./projectWords";

// The app answers a folder's dialog with kinds and numbers; these are the words the reader gets for them.

it(`says why a folder cannot have a sandbox, naming the folder or the one already holding it`, () => {
    expect(refusalSentence({ kind: `disk` }, `D:\\`)).toBe(`D:\\ is a whole disk. Open the folder of one project in it.`);
    expect(refusalSentence({ kind: `home` }, `C:\\Users\\me`)).toBe(`C:\\Users\\me is your whole home folder. Open the folder of one project in it.`);
    expect(refusalSentence({ kind: `inside`, other: `C:\\code` }, `C:\\code\\app`)).toBe(
        `This folder is inside C:\\code, which already has a sandbox. Open that folder instead.`,
    );
    expect(refusalSentence({ kind: `around`, other: `C:\\code\\app` }, `C:\\code`)).toBe(`This folder holds C:\\code\\app, which already has a sandbox of its own.`);
    for (const kind of [`holdsHome`, `homes`, `aHome`, `system`] as const) {
        expect(refusalSentence({ kind }, `/x`)).toContain(`/x `);
    }
});

it(`says what to beware of`, () => {
    expect(cautionSentence({ kind: `synced`, service: `OneDrive` })).toBe(`OneDrive already syncs this folder. Two syncs on one folder can undo each other's changes.`);
    expect(cautionSentence({ kind: `away` })).toContain(`network or removable drive`);
});

it(`counts what the first copy carries, and its size where there is one`, () => {
    expect(copyWeight({ files: 1, bytes: 0, more: false })).toBe(`1 file to copy`);
    expect(copyWeight({ files: 3, bytes: 355, more: false })).toBe(`3 files to copy, 355 B`);
    expect(copyWeight({ files: 60_000, bytes: 3 * 1024 ** 3, more: true })).toBe(`More than ${(60_000).toLocaleString()} files to copy, 3.0 GB`);
});

it(`gives every stage of the house its own headline`, () => {
    expect(stageHeadline(`walls`)).toBe(`Raising the walls`);
    expect(stageHeadline(`moving`)).toBe(`Moving your files in`);
});
