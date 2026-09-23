// The `@` picker as one list: settings above files, one highlight the parent drives, a header that names the mode,
// and the files put away while a kind is drilled.
import "@intentic/testing/dom";
import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { PickerEntry } from "../models/modelPickerState";
import type { QuickPick, QuickPickSources } from "./composerQuickPick";

// Needs jsdom: the kit's barrel reads matchMedia at import time (its device tracker), which jsdom lacks.

// modelPickerState imports conversation.ts for the live catalogs; stub its side-effects so the import is inert.
jest.mock("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: jest.fn() }));
jest.mock("../models/useChat-catalog", () => ({ loadProviderModels: jest.fn(async () => {}) }));
// The other-boxes poll is the placement menu's concern; here it only has to be started and stopped.
jest.mock("../../sandbox/live/fleetAcross", () => ({ subscribe: () => () => {} }));

// The file list under the settings, driven by hand; `seen` records what the picker asked it for.
const files = ref<readonly string[]>([]);
const seen = { query: ref(``), active: ref(false) };
jest.mock("../../workspace/search/useFuzzyFiles", () => ({
    useFuzzyFiles: (query: { value: string }, active: { value: boolean }) => {
        seen.query = query as never;
        seen.active = active as never;
        return { paths: files, floor: ref(1), searching: ref(false), pending: ref(false), truncated: ref(false), error: ref(undefined) };
    },
}));

const { default: ChatMentionPopover } = await import("./ChatMentionPopover.vue");

const entry = (provider: AgentProvider, value: string, label: string): PickerEntry => ({ key: `${provider}:${value}`, provider, value, label });
const SOURCES: QuickPickSources = {
    persona: { personas: [{ id: `intentic`, label: `Intentic`, capabilities: [] }], picked: undefined },
    sandbox: { runners: [{ id: `omen` }], boxes: [], box: undefined, runner: undefined },
    model: {
        entries: [entry(`claude`, `claude-opus-5`, `Claude Opus 5`), entry(`claude`, `claude-sonnet-4-5`, `Claude Sonnet 4.5`)],
        provider: `claude`,
        model: `claude-opus-5`,
        label: `Claude Opus 5`,
        isReady: () => true,
    },
    effort: { options: [{ label: `High`, value: `high` }], picked: `high` },
};
const NONE: QuickPickSources = { persona: undefined, sandbox: undefined, model: undefined, effort: undefined };

let app: App | undefined;
const picks: QuickPick[] = [];
const query = ref(``);
// The parent's keyboard contract, read off the template ref once the child has mounted.
const instance = ref<{ move: (delta: number) => void; pickActive: () => boolean }>();
const popover = (): { move: (delta: number) => void; pickActive: () => boolean } => instance.value!;

const mount = (sources: QuickPickSources, filesOffered = true): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        setup: () => () =>
            h(ChatMentionPopover, { ref: instance, query: query.value, sources, filesOffered, onPick: (pick: QuickPick) => picks.push(pick) }),
    });
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

// A row's words, span by span: the spans sit flush in the markup, so textContent alone would run them together.
const words = (row: Element): string =>
    [...row.querySelectorAll(`span`)]
        .map((span) => (span.textContent ?? ``).trim())
        .filter((text) => text !== ``)
        .join(` `);
const rowTexts = (element: HTMLElement): string[] => [...element.querySelectorAll(`button`)].map(words);
const header = (element: HTMLElement): string => (element.querySelector(`p`)?.textContent ?? ``).trim();
const highlighted = (element: HTMLElement): string => {
    const row = element.querySelector(`.ui-row-select-on`);
    return row === null ? `` : words(row);
};

beforeEach(() => {
    files.value = [];
    query.value = ``;
    picks.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

it(`opens on an empty token with one summary row per setting, the files still to come`, () => {
    const element = mount(SOURCES);
    expect(header(element)).toBe(`Mention a file or change a setting`);
    expect(rowTexts(element)).toEqual([`Acts as Anyone`, `Where this runs Here`, `Model Claude Opus 5`, `Effort High`]);
    expect(element.textContent).toContain(`Keep typing to search files…`);
    expect(seen.active.value).toBe(true);
    expect(seen.query.value).toBe(``);
});

it(`lists setting matches above files under one highlight the parent moves and picks`, async () => {
    files.value = [`src/high.ts`, `docs/highlights.md`];
    query.value = `hi`;
    const element = mount(SOURCES);
    await nextTick();
    expect(rowTexts(element)).toEqual([`Where this runs Here`, `Where This sandbox Here`, `Effort High`, `high.ts src`, `highlights.md docs`]);
    expect(highlighted(element)).toBe(`Where this runs Here`);
    expect(seen.query.value).toBe(`hi`);

    popover().move(2);
    await nextTick();
    expect(highlighted(element)).toBe(`Effort High`);
    expect(popover().pickActive()).toBe(true);
    expect(picks).toEqual([{ kind: `effort`, key: `effort:high`, value: `high`, label: `High`, detail: undefined, current: true }]);

    popover().move(1);
    expect(popover().pickActive()).toBe(true);
    expect(picks[1]).toEqual({ kind: `file`, key: `file:src/high.ts`, path: `src/high.ts` });
});

it(`drills into one kind: its header, its rows alone, and the file search switched off`, async () => {
    files.value = [`src/model.ts`];
    query.value = `model:`;
    const element = mount(SOURCES);
    await nextTick();
    expect(header(element)).toBe(`Model`);
    expect(rowTexts(element)).toEqual([`Model Claude Opus 5 ${providerLabel(`claude`)}`, `Model Claude Sonnet 4.5 ${providerLabel(`claude`)}`]);
    expect(seen.active.value).toBe(false);
    expect(seen.query.value).toBe(``);
    expect(element.textContent).not.toContain(`Keep typing`);

    query.value = `model:zzz`;
    await nextTick();
    expect(rowTexts(element)).toEqual([]);
    expect(element.textContent).toContain(`Nothing matches "zzz".`);
    expect(popover().pickActive()).toBe(false);
    expect(picks).toEqual([]);
});

it(`hands a summary row back as a drill and a file row back as a path`, async () => {
    files.value = [`src/app.ts`];
    const element = mount(SOURCES);
    expect(popover().pickActive()).toBe(true);
    expect(picks[0]).toMatchObject({ kind: `drill`, into: `persona` });

    query.value = `app`;
    await nextTick();
    expect(rowTexts(element)).toEqual([`app.ts src`]);
    expect(popover().pickActive()).toBe(true);
    expect(picks[1]).toEqual({ kind: `file`, key: `file:src/app.ts`, path: `src/app.ts` });
});

it(`names the mode in the header when only one side is offered`, () => {
    expect(header(mount(SOURCES, false))).toBe(`Change a setting`);
    app?.unmount();
    expect(header(mount(NONE, true))).toBe(`Mention a file`);
});

it(`shows the current pick ticked and nothing else`, () => {
    query.value = `effort:`;
    const element = mount(SOURCES);
    expect(element.querySelectorAll(`[data-icon="check"]`)).toHaveLength(1);
    expect(element.querySelector(`[data-icon="check"]`)?.closest(`button`)?.textContent).toContain(`High`);
});
