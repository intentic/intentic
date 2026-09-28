import type { MenuItem } from "primevue/menuitem";
import { type ChangeRowMenuInput, type ChangeRowVerbs, changeRowMenuItems } from "./changeRowMenu";

// Pins which rows a Changes row's right-click offers, for one file, a deleted one, a selection, and a busy index.

const verbs = (): ChangeRowVerbs => ({
    openChanges: jest.fn(),
    openFile: jest.fn(),
    reveal: jest.fn(),
    stage: jest.fn(),
    discard: jest.fn(),
    copyPath: jest.fn(),
    copyRepoPath: jest.fn(),
});

const input = (over: Partial<ChangeRowMenuInput> = {}): ChangeRowMenuInput => ({
    multi: false,
    paths: 1,
    sameSide: 1,
    indexVerb: `Stage`,
    indexIcon: `plus`,
    deleted: false,
    nested: true,
    busy: false,
    verbs: verbs(),
    ...over,
});

const labels = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));

it(`offers one file its looks, its git verbs and both of its paths`, () => {
    expect(labels(changeRowMenuItems(input()))).toEqual([
        `Open Changes`,
        `Open File`,
        `Reveal in Explorer`,
        `—`,
        `Stage`,
        `Discard Changes`,
        `—`,
        `Copy Path`,
        `Copy Path in Repo`,
    ]);
});

it(`leaves a deleted file only its diff to look at, and a root repo's file one path`, () => {
    expect(labels(changeRowMenuItems(input({ deleted: true, nested: false })))).toEqual([
        `Open Changes`,
        `—`,
        `Stage`,
        `Discard Changes`,
        `—`,
        `Copy Path`,
    ]);
});

it(`counts a selection into the verbs that act on it, dropping the ones that name one file`, () => {
    expect(labels(changeRowMenuItems(input({ multi: true, paths: 3, sameSide: 2 })))).toEqual([
        `Stage (2)`,
        `Discard Changes (3)`,
        `—`,
        `Copy 3 Paths`,
        `Copy 3 Paths in Repo`,
    ]);
});

it(`disables the git verbs while one is running, but never the copies`, () => {
    const items = changeRowMenuItems(input({ busy: true }));
    const disabled = items.filter((item) => item.disabled === true).map((item) => item.label);
    expect(disabled).toEqual([`Stage`, `Discard Changes`]);
});

it(`runs the verb behind the row`, () => {
    const given = verbs();
    const copy = changeRowMenuItems(input({ verbs: given })).find((item) => item.label === `Copy Path`);
    copy?.command?.({ originalEvent: new Event(`click`), item: copy });
    expect(given.copyPath).toHaveBeenCalledTimes(1);
});
