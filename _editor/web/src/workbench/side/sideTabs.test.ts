import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { nextTick, ref } from "vue";
import type { SideInput } from "./sideTabs";

const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const activeSandboxId = ref<string | undefined>(`sb1`);
jest.mock("../../lib/activeSandbox", () => ({ activeSandboxId }));

const { activateTab, closeAllTabs, closeOtherTabs, closeTab, cycleTab, keepTab, openBeside, setSplit, sideTabId, useSidePanel } =
    await import("./sideTabs");

const panel = useSidePanel();
const file = (path: string): SideInput => ({ path });
const idOf = (path: string): string => sideTabId(`file`, file(path));
const paths = (): string[] => panel.tabs.value.map((tab) => String(tab.input[`path`] ?? tab.view));

beforeEach(() => {
    local.clear();
    session.clear();
    activeSandboxId.value = `sb1`;
    resetSandboxScope();
});

describe(`peeks`, () => {
    it(`replaces the peek in place when the next link opens, so following links reads as one tab changing`, () => {
        openBeside(`file`, file(`a.ts`), { keep: true });
        openBeside(`file`, file(`b.ts`));
        openBeside(`file`, file(`c.ts`));

        expect(paths()).toEqual([`a.ts`, `c.ts`]);
        expect(panel.peek.value).toBe(idOf(`c.ts`));
        expect(panel.active.value).toBe(idOf(`c.ts`));
    });

    it(`keeps a kept peek when the next link opens, which becomes the new peek beside it`, () => {
        openBeside(`file`, file(`a.ts`));
        keepTab(idOf(`a.ts`));
        openBeside(`file`, file(`b.ts`));

        expect(paths()).toEqual([`a.ts`, `b.ts`]);
        expect(panel.peek.value).toBe(idOf(`b.ts`));
    });

    it(`focuses the tab already showing a target instead of opening a second one`, () => {
        openBeside(`file`, file(`a.ts`), { keep: true });
        openBeside(`file`, file(`b.ts`), { keep: true });
        openBeside(`file`, file(`a.ts`));

        expect(paths()).toEqual([`a.ts`, `b.ts`]);
        expect(panel.active.value).toBe(idOf(`a.ts`));
        expect(panel.peek.value).toBeNull();
    });

    it(`promotes the peek when the same target is opened to keep`, () => {
        openBeside(`file`, file(`a.ts`));
        openBeside(`file`, file(`a.ts`), { keep: true });

        expect(panel.peek.value).toBeNull();
        expect(paths()).toEqual([`a.ts`]);
    });

    it(`adds a deliberate open beside the peek rather than replacing it`, () => {
        openBeside(`file`, file(`a.ts`));
        openBeside(`preview`, {}, { keep: true });

        expect(paths()).toEqual([`a.ts`, `preview`]);
        expect(panel.peek.value).toBe(idOf(`a.ts`));
        expect(panel.active.value).toBe(sideTabId(`preview`, {}));
    });

    it(`reads one input as one tab whatever order its keys were written in`, () => {
        expect(sideTabId(`x/run`, { repo: `web`, runId: 4 })).toBe(sideTabId(`x/run`, { runId: 4, repo: `web` }));
        expect(sideTabId(`x/run`, { repo: `web`, runId: 4 })).not.toBe(sideTabId(`x/run`, { repo: `web`, runId: 5 }));
    });
});

describe(`line jumps`, () => {
    it(`lands the same tab on each line asked for, re-firing for a line asked twice`, () => {
        openBeside(`file`, file(`a.ts`), { line: 12 });
        const first = panel.jumps.value[idOf(`a.ts`)];
        openBeside(`file`, file(`a.ts`), { line: 12 });
        const second = panel.jumps.value[idOf(`a.ts`)];

        expect(paths()).toEqual([`a.ts`]);
        expect(first?.line).toBe(12);
        expect(second?.line).toBe(12);
        expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    });

    it(`forgets a closed tab's landing`, () => {
        openBeside(`file`, file(`a.ts`), { line: 3 });
        closeTab(idOf(`a.ts`));

        expect(Object.keys(panel.jumps.value)).toEqual([]);
    });
});

describe(`closing`, () => {
    beforeEach(() => {
        for (const path of [`a.ts`, `b.ts`, `c.ts`]) {
            openBeside(`file`, file(path), { keep: true });
        }
    });

    it(`lands on the tab to the right of a closed focus, else the one to its left`, () => {
        activateTab(idOf(`b.ts`));
        closeTab(idOf(`b.ts`));
        expect(panel.active.value).toBe(idOf(`c.ts`));

        closeTab(idOf(`c.ts`));
        expect(panel.active.value).toBe(idOf(`a.ts`));

        closeTab(idOf(`a.ts`));
        expect(panel.active.value).toBeNull();
    });

    it(`leaves focus where it was when another tab closes`, () => {
        activateTab(idOf(`a.ts`));
        closeTab(idOf(`c.ts`));

        expect(panel.active.value).toBe(idOf(`a.ts`));
        expect(paths()).toEqual([`a.ts`, `b.ts`]);
    });

    it(`closes the others around one tab, and everything`, () => {
        closeOtherTabs(idOf(`b.ts`));
        expect(paths()).toEqual([`b.ts`]);
        expect(panel.active.value).toBe(idOf(`b.ts`));

        closeAllTabs();
        expect(paths()).toEqual([]);
        expect(panel.active.value).toBeNull();
    });

    it(`clears the peek with the peek's tab, and the split with the last tab`, () => {
        openBeside(`file`, file(`d.ts`));
        setSplit(true);
        closeTab(idOf(`d.ts`));
        expect(panel.peek.value).toBeNull();
        expect(panel.split.value).toBe(true);

        closeAllTabs();
        expect(panel.split.value).toBe(false);
    });

    it(`walks the tabs with wrap-around`, () => {
        activateTab(idOf(`c.ts`));
        cycleTab(1);
        expect(panel.active.value).toBe(idOf(`a.ts`));
        cycleTab(-1);
        expect(panel.active.value).toBe(idOf(`c.ts`));
    });
});

describe(`what survives a reload`, () => {
    const key = `intentic.sidePanel.sb1`;

    it(`stores the tabs, the focus, the peek and the split under this window's sandbox`, async () => {
        openBeside(`file`, file(`a.ts`), { keep: true, line: 9 });
        openBeside(`file`, file(`b.ts`));
        await nextTick();

        expect(JSON.parse(session.get(key) ?? `null`)).toEqual({
            tabs: [
                { view: `file`, input: { path: `a.ts` } },
                { view: `file`, input: { path: `b.ts` } },
            ],
            active: idOf(`b.ts`),
            peek: idOf(`b.ts`),
            split: false,
        });
        expect(local.get(key)).toBe(session.get(key));
    });

    it(`restores what was stored, skipping an unreadable tab and a second copy of one`, () => {
        session.set(
            key,
            JSON.stringify({
                tabs: [
                    { view: `file`, input: { path: `a.ts` } },
                    { view: ``, input: {} },
                    { view: `file`, input: { path: { nested: true } } },
                    { view: `file`, input: { path: `a.ts` } },
                    { view: `preview`, input: {} },
                ],
                active: `nothing by this name`,
                peek: sideTabId(`preview`, {}),
                collapsed: true,
            }),
        );
        resetSandboxScope();

        expect(paths()).toEqual([`a.ts`, `preview`]);
        expect(panel.active.value).toBe(sideTabId(`preview`, {}));
        expect(panel.peek.value).toBe(sideTabId(`preview`, {}));
    });

    it(`opens empty on a payload that is not the panel's`, () => {
        session.set(key, `{not json`);
        resetSandboxScope();
        expect(paths()).toEqual([]);

        session.set(key, JSON.stringify({ tabs: `none` }));
        resetSandboxScope();
        expect(paths()).toEqual([]);
    });

    it(`keeps each sandbox's tabs to itself across a switch`, async () => {
        openBeside(`file`, file(`a.ts`), { keep: true });
        await nextTick();

        activeSandboxId.value = `sb2`;
        resetSandboxScope();
        expect(paths()).toEqual([]);
        openBeside(`file`, file(`z.ts`), { keep: true });
        await nextTick();

        activeSandboxId.value = `sb1`;
        resetSandboxScope();
        expect(paths()).toEqual([`a.ts`]);
        expect(JSON.parse(session.get(`intentic.sidePanel.sb2`) ?? `null`).tabs).toEqual([{ view: `file`, input: { path: `z.ts` } }]);
    });
});
