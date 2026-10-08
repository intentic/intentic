// jsdom because the subject is the bar: which presses a refusal offers, and the one line saying why, both template
// decisions across the states a refused land can be in.
import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { LandConflict } from "@intentic/sandbox-contract";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: AgentConflictReport } = await import("./AgentConflictReport.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

// Spelled out rather than a loose record, so a prop renamed on the component fails here instead of being silently
// ignored. The props the tests rarely vary are defaulted below.
interface ReportProps {
    readonly conflicts: readonly LandConflict[];
    readonly streaming?: boolean;
    readonly writing?: boolean;
    readonly busy?: boolean;
    readonly asked?: boolean;
    readonly queued?: boolean;
    readonly box?: string;
    readonly onSaveSettings?: (paths: readonly string[]) => void;
    readonly onShow?: () => void;
    readonly onCancel?: () => void;
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
                queued: false,
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

const press = (el: HTMLElement, label: string): void => [...el.querySelectorAll(`button`)].find((b) => (b.textContent ?? ``).includes(label))!.click();

// The fix is the header's press; offering it here too was one decision drawn twice.
it(`says how many files conflict and why, and leaves the fix to the header`, async () => {
    const el = await mount({ conflicts: agentsToFix });
    expect(text(el)).toContain(`1 file conflicts`);
    expect(text(el)).toContain(`Nothing landed yet.`);
    expect(text(el)).toContain(`They changed in your workspace after the agent started.`);
    expect(hasButton(el, `Fix`)).toBe(false);
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
    expect(hasButton(el, `Open in`)).toBe(false);
});

// The paths were a wall of monorepo paths in the bar; now the list below narrows to them.
it(`hands the paths to the list instead of printing them`, async () => {
    let shown = 0;
    const el = await mount({ conflicts: mixed, onShow: () => (shown += 1) });
    expect(text(el)).not.toContain(`src/server.ts`);
    press(el, `Show`);
    expect(shown).toBe(1);
});

// Two causes: a count per cause, in one line.
it(`counts each cause in one line when they differ`, async () => {
    const el = await mount({ conflicts: mixed });
    expect(text(el)).toContain(`2 files conflict`);
    expect(text(el)).toContain(`1 changed in your workspace · 1 has your uncommitted edits`);
});

// Asking the agent and committing locally can't reach another sandbox, so the crossing is the offer; the merge is
// addressed by agent id and writes into the actual workspace, so it stays.
it(`offers the crossing when the agent is in another box`, async () => {
    const el = await mount({ conflicts: agentsToFix, box: `acme-laptop` });
    expect(hasButton(el, `Open Changes`)).toBe(false);
    expect(hasButton(el, `Open in acme-laptop`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
});

it(`only offers the merge when git could apply it`, async () => {
    const el = await mount({ conflicts: mixed, box: `acme-laptop` });
    expect(hasButton(el, `Land with conflict markers`)).toBe(false);
    expect(hasButton(el, `Open in acme-laptop`)).toBe(true);
});

// The local path is unaffected: a conflict in the box you're standing in still ends on the user's own move.
it(`keeps the user's own press on a local conflict held by their uncommitted edits`, async () => {
    const el = await mount({ conflicts: mixed });
    expect(hasButton(el, `Open Changes`)).toBe(true);
    expect(text(el)).toContain(`Commit, then land again.`);
    expect(hasButton(el, `Land with conflict markers`)).toBe(false);
    expect(hasButton(el, `Open in`)).toBe(false);
});

// While the fix runs, re-asking or landing over it is not a real choice: the bar says so and offers only Stop.
it(`says the agent is fixing them while it does, and offers Stop instead of the merge`, async () => {
    const el = await mount({ conflicts: agentsToFix, asked: true, streaming: true });
    expect(text(el)).toContain(`The agent is fixing them, then lands.`);
    expect(hasButton(el, `Stop`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(false);
});

// A fix pressed during a turn waits for it rather than being refused, and can be taken back.
it(`says a queued fix waits for the turn, and lets it be cancelled`, async () => {
    let cancelled = 0;
    const el = await mount({ conflicts: agentsToFix, queued: true, streaming: true, onCancel: () => (cancelled += 1) });
    expect(text(el)).toContain(`The fix starts when the current turn ends.`);
    press(el, `Cancel`);
    expect(cancelled).toBe(1);
});

// A land refused over personas.json as "your uncommitted edits", although only the Personas page had written it: the
// bar names the page, and one press saves those files and lands.
const settingsHeld: LandConflict[] = [
    {
        repo: `root`,
        clean: 3,
        mainBranch: `main`,
        paths: [
            { path: `${STATE_DIR}/config/personas.json`, reason: `workspace` },
            { path: `${STATE_DIR}/config/capabilities.json`, reason: `workspace` },
        ],
    },
];

it(`names the Sandbox page behind settings files it holds, and saves them and lands in one press`, async () => {
    const saved: (readonly string[])[] = [];
    const el = await mount({ conflicts: settingsHeld, onSaveSettings: (paths) => saved.push(paths) });

    expect(text(el)).toContain(`Settings changed on the Personas, Capabilities page aren't saved yet.`);
    expect(text(el)).not.toContain(`uncommitted edits`);
    expect(hasButton(el, `Open Changes`)).toBe(false);

    press(el, `Save settings and land`);
    expect(saved).toEqual([[`.intentic/config/personas.json`, `.intentic/config/capabilities.json`]]);
});

// The agent's own part still blocks too; the settings press stays, and the files still don't read as the owner's.
it(`keeps the settings press when the agent's half blocks as well`, async () => {
    const conflicts: LandConflict[] = [{ ...settingsHeld[0]!, paths: [...settingsHeld[0]!.paths, { path: `src/server.ts`, reason: `diverged` }] }];
    const el = await mount({ conflicts });

    expect(hasButton(el, `Save settings and land`)).toBe(true);
    expect(text(el)).toContain(`1 changed in your workspace · 2 unsaved settings`);
});

it(`keeps sending the owner to Changes once any held file is their own`, async () => {
    const conflicts: LandConflict[] = [
        { ...settingsHeld[0]!, paths: [...settingsHeld[0]!.paths, { path: `src/db/schema.ts`, reason: `workspace` }] },
    ];
    const el = await mount({ conflicts });

    expect(hasButton(el, `Open Changes`)).toBe(true);
    expect(hasButton(el, `Save settings and land`)).toBe(false);
    expect(text(el)).toContain(`You have uncommitted edits in them.`);
});
