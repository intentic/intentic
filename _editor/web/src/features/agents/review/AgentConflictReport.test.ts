// jsdom because the subject is the ladder: which rungs a refusal offers, and the sentence claiming them beside it,
// both template decisions across five states.
import "@intentic/testing/dom";
import type { LandConflict } from "@intentic/sandbox-contract";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: AgentConflictReport } = await import("./AgentConflictReport.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

// Spelled out rather than a loose record, so a prop renamed on the component fails here instead of being silently
// ignored. Four props the tests never vary are defaulted below.
interface ReportProps {
    readonly conflicts: readonly LandConflict[];
    readonly streaming?: boolean;
    readonly writing?: boolean;
    readonly busy?: boolean;
    readonly asked?: boolean;
    readonly box?: string;
    readonly onSaveSettings?: (paths: readonly string[]) => void;
}

const mount = async (props: ReportProps): Promise<HTMLElement> => {
    host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(AgentConflictReport, {
                streaming: false,
                writing: false,
                busy: false,
                asked: false,
                ...props,
            }),
    });
    // `Icon` is a stand-in here; no assertion is about a glyph.
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    jest.restoreAllMocks();
});

const text = (el: HTMLElement): string => (el.textContent ?? ``).replace(/\s+/g, ` `).trim();
const hasButton = (el: HTMLElement, label: string): boolean => [...el.querySelectorAll(`button`)].some((b) => (b.textContent ?? ``).includes(label));

// A refusal the agent can clear alone; the only shape here that offers the merge button.
const agentsToFix: LandConflict[] = [{ repo: `api`, clean: 1, mainBranch: `main`, paths: [{ path: `src/server.ts`, reason: `diverged` }] }];

// Same refusal plus the user's own uncommitted work, the shape a real conflict usually has.
const mixed: LandConflict[] = [
    {
        repo: `api`,
        clean: 1,
        mainBranch: `main`,
        paths: [
            { path: `src/server.ts`, reason: `diverged` },
            { path: `src/db/schema.ts`, reason: `workspace` },
        ],
    },
];

it(`offers the agent, the user and the merge when the conflict is the agent's alone and this is its own box`, async () => {
    const el = await mount({ conflicts: agentsToFix });
    expect(hasButton(el, `Have the agent resolve it`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
    expect(hasButton(el, `Open in`)).toBe(false);
});

// The two rungs that can't reach another sandbox (asking the agent, committing locally) collapse into the
// crossing; landing is neither, so it stays put.
it(`replaces both of those rungs with one crossing when the agent is in another box`, async () => {
    const el = await mount({ conflicts: agentsToFix, box: `acme-laptop` });
    expect(hasButton(el, `Have the agent resolve it`)).toBe(false);
    expect(hasButton(el, `Open Changes`)).toBe(false);
    expect(hasButton(el, `Open in acme-laptop`)).toBe(true);
    // The land is addressed by agent id and writes into the actual workspace, so it crosses intact.
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
});

// The crossing's sentence claimed landing still worked unconditionally, false whenever a `workspace` blocker
// makes `mergeable` false and hides the row.
it(`only promises the merge when the merge is actually on offer`, async () => {
    const withMerge = await mount({ conflicts: agentsToFix, box: `acme-laptop` });
    expect(hasButton(withMerge, `Land with conflict markers`)).toBe(true);
    const withMergeText = text(withMerge);
    expect(withMergeText).toContain(`Land with conflict markers`);

    app?.unmount();
    host?.remove();

    const withoutMerge = await mount({ conflicts: mixed, box: `acme-laptop` });
    expect(hasButton(withoutMerge, `Land with conflict markers`)).toBe(false);
    const withoutMergeText = text(withoutMerge);
    expect(withoutMergeText).not.toContain(`Land with conflict markers still works`);
    expect(withoutMergeText).toContain(`acme-laptop`);
    expect(withoutMergeText).toContain(`edits`);
});

// The local path is unaffected: a conflict in the box you're standing in still ends on the user's own move.
it(`keeps the user's own rung on a local conflict held by their uncommitted edits`, async () => {
    const el = await mount({ conflicts: mixed });
    expect(hasButton(el, `Open Changes`)).toBe(true);
    expect(hasButton(el, `Have the agent resolve it`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(false);
    expect(hasButton(el, `Open in`)).toBe(false);
});

// A land refused over personas.json as "your uncommitted edits", although only the Personas page had written it: the
// report names the page, and one press saves those files and lands.
const settingsHeld: LandConflict[] = [
    {
        repo: `root`,
        clean: 3,
        mainBranch: `main`,
        paths: [
            { path: `.intentic/config/personas.json`, reason: `workspace` },
            { path: `.intentic/config/capabilities.json`, reason: `workspace` },
        ],
    },
];

it(`names the Sandbox page behind settings files it holds, and saves them and lands in one press`, async () => {
    const saved: (readonly string[])[] = [];
    const el = await mount({ conflicts: settingsHeld, onSaveSettings: (paths) => saved.push(paths) });

    expect(text(el)).toContain(`changed on the Sandbox page Personas, Capabilities, not saved yet`);
    expect(text(el)).not.toContain(`you have uncommitted edits`);
    expect(hasButton(el, `Open Changes`)).toBe(false);

    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Save them and land`))!.click();
    expect(saved).toEqual([[`.intentic/config/personas.json`, `.intentic/config/capabilities.json`]]);
});

// The agent's own part still blocks too: its rung comes first, and the settings files no longer read as the owner's.
it(`offers the agent's rung first and the settings press beside it when both halves block`, async () => {
    const conflicts: LandConflict[] = [{ ...settingsHeld[0]!, paths: [...settingsHeld[0]!.paths, { path: `src/server.ts`, reason: `diverged` }] }];
    const el = await mount({ conflicts });

    expect(hasButton(el, `Have the agent resolve it`)).toBe(true);
    expect(hasButton(el, `Save them and land`)).toBe(true);
    expect(text(el)).not.toContain(`still needs you`);
});

it(`keeps sending the owner to Changes once any held file is their own`, async () => {
    const conflicts: LandConflict[] = [{ ...settingsHeld[0]!, paths: [...settingsHeld[0]!.paths, { path: `src/db/schema.ts`, reason: `workspace` }] }];
    const el = await mount({ conflicts });

    expect(hasButton(el, `Open Changes`)).toBe(true);
    expect(hasButton(el, `Save them and land`)).toBe(false);
    expect(text(el)).toContain(`you have uncommitted edits to these`);
});
