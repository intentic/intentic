import type { UninstallInventory, UninstallProgress } from "../../desktopUninstall";
import { registerDesktopCatalog } from "../../i18n";
import {
    checklistOf,
    choiceQuestion,
    choiceWords,
    cleanEnd,
    countTyped,
    currentStep,
    dataBytes,
    fateWord,
    ledger,
    needsCount,
    percentOf,
    primaryLabel,
    runArgs,
    sandboxLine,
    sizeOf,
    staysAfter,
    staysSentence,
    thingsOf,
} from "./uninstallModel";

// The uninstall dialog as it reads ic's inventory (the contract's own example shapes): what each part comes to under each
// choice, the words of the choice and of the one button, the typed count that gates a deletion, the arguments the run
// is given, and the checklist while it runs. In English, so what is asserted is what a reader sees.

await registerDesktopCatalog();

const PLAN = {
    everything: [
        { step: `stop`, label: `Stop Intentic` },
        { step: `sandboxes`, label: `Delete 3 sandboxes` },
        { step: `agent`, label: `Remove the machine agent, folder sync and your saved passwords` },
        { step: `engine`, label: `Remove the intentic engine` },
        { step: `files`, label: `Delete Intentic's files and caches` },
        { step: `ic`, label: `Remove ic` },
    ],
    "keep-sandboxes": [
        { step: `sync`, label: `Stop syncing 2 folders` },
        { step: `files`, label: `Delete caches` },
    ],
};

const FULL: UninstallInventory = {
    version: 1,
    os: `windows`,
    sandboxes: [
        { slug: `sandbox-ab12`, kind: `sandbox`, state: `running`, bytes: 4_100_000_000 },
        { slug: `sandbox-cd34`, kind: `sandbox`, state: `stopped`, bytes: 17_900_000_000 },
        { slug: `sandbox-old`, kind: `sandbox`, state: `removed`, bytes: null },
    ],
    deleteCount: 3,
    passwords: true,
    engine: { bytes: 18_000_000_000, holdsOthers: false },
    agent: { folders: 2, distros: [`Ubuntu`] },
    app: { version: `1.340.0` },
    cacheBytes: 1_400_000_000,
    stays: [`Docker Desktop`, `WSL`, `the files in your synced folders`],
    steps: PLAN,
};

/** A computer that only opened folders: no sandbox, no passwords, no engine, no agent. */
const EMPTY: UninstallInventory = {
    ...FULL,
    sandboxes: [],
    deleteCount: 0,
    passwords: false,
    engine: null,
    agent: null,
    app: null,
    cacheBytes: 0,
    stays: [],
};

const PASSWORDS_ONLY: UninstallInventory = { ...EMPTY, passwords: true, agent: { folders: 0, distros: [] } };

describe(`sizes and counts`, () => {
    it(`says sizes as ic says them, decimal, a place below a hundred`, () => {
        expect([sizeOf(512), sizeOf(820_000_000), sizeOf(4_100_000_000), sizeOf(22_040_000_000), sizeOf(180_000_000_000)]).toEqual([
            `512 B`,
            `820 MB`,
            `4.1 GB`,
            `22.0 GB`,
            `180 GB`,
        ]);
    });

    it(`spells the count out, runners by their own name`, () => {
        expect(thingsOf(FULL)).toBe(`3 sandboxes`);
        expect(thingsOf({ ...FULL, sandboxes: [FULL.sandboxes[0]!], deleteCount: 1 })).toBe(`1 sandbox`);
        const withRunner = { ...FULL, sandboxes: [...FULL.sandboxes, { slug: `runner-x`, kind: `runner`, state: `running`, bytes: null }], deleteCount: 4 };
        expect(thingsOf(withRunner)).toBe(`3 sandboxes and 1 runner`);
        expect(thingsOf({ ...FULL, sandboxes: [{ slug: `runner-x`, kind: `runner`, state: `running`, bytes: null }], deleteCount: 1 })).toBe(`1 runner`);
    });

    it(`adds up only what ic could measure`, () => {
        expect(dataBytes(FULL)).toBe(22_000_000_000);
        expect(dataBytes({ ...FULL, sandboxes: [FULL.sandboxes[2]!] })).toBeUndefined();
        expect(sandboxLine(FULL.sandboxes[2]!)).toEqual({ name: `sandbox-old`, state: `removed, still recoverable`, size: undefined });
        expect(sandboxLine(FULL.sandboxes[0]!)).toEqual({ name: `sandbox-ab12`, state: `running`, size: `4.1 GB` });
        // Docker could not describe it: nothing is said about how it stands.
        expect(sandboxLine({ slug: `odd`, kind: `sandbox`, state: `unknown`, bytes: 0 })).toEqual({ name: `odd`, state: ``, size: undefined });
    });
});

describe(`the ledger`, () => {
    it(`lists the reader's things first, then what ran them, then the app, each with what each choice does to it`, () => {
        const rows = ledger(FULL);
        expect(rows.map((row) => [row.id, row.fate.everything, row.fate[`keep-sandboxes`]])).toEqual([
            [`sandboxes`, `deleted`, `stays`],
            [`passwords`, `deleted`, `stays`],
            [`engine`, `removed`, `stays`],
            [`agent`, `removed`, `stays`],
            [`sync`, `removed`, `removed`],
            [`caches`, `removed`, `removed`],
            [`app`, `removed`, `removed`],
        ]);
        expect(rows[0]).toMatchObject({ title: `3 sandboxes`, size: `22.0 GB` });
        expect(rows[3]?.detail).toBe(`Also in WSL: Ubuntu`);
        expect(rows[4]?.detail).toBe(`2 folders. Their files stay where they are.`);
        expect(rows[6]?.detail).toBe(`Version 1.340.0`);
    });

    it(`says each fate in one word`, () => {
        expect([fateWord(`deleted`), fateWord(`removed`), fateWord(`stays`)]).toEqual([`Deleted`, `Removed`, `Stays`]);
    });

    it(`keeps an engine that also runs other containers, whatever is chosen`, () => {
        const engine = ledger({ ...FULL, engine: { bytes: null, holdsOthers: true } }).find((row) => row.id === `engine`);
        expect(engine?.fate).toEqual({ everything: `stays`, "keep-sandboxes": `stays` });
        expect(engine?.detail).toBe(`It also runs containers that aren't Intentic's, so it stays.`);
        expect(engine?.size).toBeUndefined();
    });

    it(`always has the app, named by the version the app knows when ic did not say`, () => {
        expect(ledger(EMPTY).map((row) => row.id)).toEqual([`app`]);
        expect(ledger(EMPTY, `1.341.0`)[0]?.detail).toBe(`Version 1.341.0`);
        // A working-tree build has no version worth naming.
        expect(ledger(EMPTY, `0.0.0`)[0]?.detail).toBeUndefined();
    });
});

describe(`the choice and the one button`, () => {
    it(`says what removing everything deletes, with its size, and that it cannot be undone`, () => {
        const words = choiceWords(FULL);
        expect(words.everything).toEqual({
            title: `Remove everything`,
            body: `Deletes 3 sandboxes and their files (22.0 GB), and your saved passwords. This can't be undone.`,
        });
        expect(words[`keep-sandboxes`]).toEqual({
            title: `Keep my sandboxes`,
            body: `They keep running on this computer. Only the app, folder sync and caches are removed.`,
        });
        expect(choiceQuestion(FULL)).toBe(`What should happen to your sandboxes?`);
    });

    it(`names saved passwords as the thing kept when there is no sandbox`, () => {
        const words = choiceWords(PASSWORDS_ONLY);
        expect(words.everything.body).toBe(`Deletes your saved passwords. This can't be undone.`);
        expect(words[`keep-sandboxes`]).toEqual({
            title: `Keep my saved passwords`,
            body: `They stay on this computer. Only the app and its caches are removed.`,
        });
        expect(choiceQuestion(PASSWORDS_ONLY)).toBe(`What should happen to your saved passwords?`);
    });

    it(`labels the button with exactly what it does`, () => {
        expect(primaryLabel(FULL, `everything`)).toBe(`Uninstall and delete 3 sandboxes`);
        expect(primaryLabel(FULL, `keep-sandboxes`)).toBe(`Uninstall, keep my sandboxes`);
        expect(primaryLabel(EMPTY, `everything`)).toBe(`Uninstall Intentic`);
        // Nothing of the reader's: no choice is offered, and the button says so whatever was last picked.
        expect(primaryLabel(EMPTY, `keep-sandboxes`)).toBe(`Uninstall Intentic`);
        expect(primaryLabel(PASSWORDS_ONLY, `everything`)).toBe(`Uninstall and delete your passwords`);
        expect(primaryLabel(PASSWORDS_ONLY, `keep-sandboxes`)).toBe(`Uninstall, keep my passwords`);
    });

    it(`holds the button until the count of sandboxes about to be deleted is typed`, () => {
        expect(needsCount(FULL, `everything`)).toBe(true);
        expect(countTyped(FULL, `everything`, ``)).toBe(false);
        expect(countTyped(FULL, `everything`, `2`)).toBe(false);
        expect(countTyped(FULL, `everything`, `three`)).toBe(false);
        expect(countTyped(FULL, `everything`, ` 3 `)).toBe(true);
        // Keeping them, or having none, deletes no sandbox: nothing to type.
        expect(needsCount(FULL, `keep-sandboxes`)).toBe(false);
        expect(countTyped(FULL, `keep-sandboxes`, ``)).toBe(true);
        expect(needsCount(PASSWORDS_ONLY, `everything`)).toBe(false);
        expect(countTyped(EMPTY, `everything`, ``)).toBe(true);
    });

    it(`hands the run the choice, and the typed count only for a deletion of sandboxes`, () => {
        expect(runArgs(FULL, `everything`)).toEqual({ choice: `everything`, confirm: 3 });
        expect(runArgs(FULL, `keep-sandboxes`)).toEqual({ choice: `keep-sandboxes`, confirm: null });
        expect(runArgs(PASSWORDS_ONLY, `everything`)).toEqual({ choice: `everything`, confirm: null });
        expect(runArgs(EMPTY, `keep-sandboxes`)).toEqual({ choice: `everything`, confirm: null });
    });

    it(`says what stays as one sentence, or nothing`, () => {
        expect(staysSentence(FULL.stays)).toBe(`Stays on this computer: Docker Desktop, WSL, and the files in your synced folders.`);
        expect(staysSentence([])).toBeUndefined();
    });
});

describe(`while it runs`, () => {
    const running = (steps: UninstallProgress[`steps`], outcome: UninstallProgress[`outcome`] = null): UninstallProgress => ({
        choice: `everything`,
        steps,
        outcome,
        log: null,
    });

    it(`draws the inventory's plan until ic has said its own`, () => {
        const before = checklistOf(FULL, `keep-sandboxes`, undefined);
        expect(before).toEqual([
            { step: `sync`, label: `Stop syncing 2 folders`, state: `pending`, detail: null },
            { step: `files`, label: `Delete caches`, state: `pending`, detail: null },
        ]);
        expect(checklistOf(FULL, `everything`, running([]))).toHaveLength(6);
        const said = running([{ step: `stop`, label: `Stop Intentic`, state: `running`, detail: null }]);
        expect(checklistOf(FULL, `everything`, said)).toEqual([...said.steps]);
    });

    it(`puts the running step in front, else the next, and counts every step that is over`, () => {
        const steps = [
            { step: `stop`, label: `Stop Intentic`, state: `done`, detail: null },
            { step: `distros`, label: `Remove Intentic from WSL (Ubuntu)`, state: `skipped`, detail: null },
            { step: `sandboxes`, label: `Delete 3 sandboxes`, state: `running`, detail: `sandbox-cd34` },
            { step: `files`, label: `Delete Intentic's files and caches`, state: `pending`, detail: null },
        ];
        expect(currentStep(steps)?.step).toBe(`sandboxes`);
        expect(percentOf(steps)).toBe(50);
        const between = steps.map((step) => (step.state === `running` ? { ...step, state: `done` } : step));
        expect(currentStep(between)?.step).toBe(`files`);
        expect(currentStep(between.map((step) => ({ ...step, state: `done` })))).toBeUndefined();
        expect(percentOf([])).toBe(0);
    });

    it(`ends clean only when ic said done and named no failure`, () => {
        expect(cleanEnd({ result: `done`, stays: [], failed: [], code: 0 })).toBe(true);
        expect(cleanEnd({ result: `partial`, stays: [], failed: [], code: 1 })).toBe(false);
        expect(cleanEnd({ result: `done`, stays: [], failed: [{ label: `Remove ic`, problem: `in use`, fix: null }], code: 0 })).toBe(false);
    });

    it(`says what stays as ic said it at the end, else as it said before`, () => {
        expect(staysAfter({ result: `done`, stays: [`Docker Desktop`], failed: [], code: 0 }, FULL)).toEqual([`Docker Desktop`]);
        expect(staysAfter({ result: `done`, stays: [], failed: [], code: 0 }, FULL)).toEqual(FULL.stays);
        expect(staysAfter(null, undefined)).toEqual([]);
    });
});
