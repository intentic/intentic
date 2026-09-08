// @vitest-environment jsdom
// Pins the per-state verbs (add to the image, ask an agent, dismiss) for a runtime install the daemon can report but
// never resolve without one.
import type { EnvironmentRecurring } from "@intentic/api-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Fetch is stubbed to fail, mirroring an offline sandbox, so every mark paints its glyph tier.
vi.hoisted(() => {
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch;
});

// Starting a turn opens a chat through app-wide singletons; this captures the press instead.
const started: string[] = [];
vi.mock(`../../agents/fleet/agentActions`, () => ({ startAgent: (prompt: string) => started.push(prompt) }));

const { default: RuntimeInstalls } = await import("./RuntimeInstalls.vue");

const entry = (over: Partial<EnvironmentRecurring> & Pick<EnvironmentRecurring, "tool" | "kind">): EnvironmentRecurring => ({
    sessions: 2,
    lastAt: Date.parse(`2026-09-03T00:00:00Z`),
    live: true,
    ...over,
});

// One of each state: a templatable step, an ecosystem with no step, and one already drafted into the proposal.
const TEMPLATABLE = entry({
    tool: `chromium-headless-shell`,
    kind: `playwright`,
    step: `RUN --mount=type=cache,target=/root/.npm \\\n    npx --yes playwright install --with-deps chromium-headless-shell`,
});
const HUMAN = entry({ tool: `zizmor`, kind: `pip`, sessions: 3 });
const DRAFTED = entry({ tool: `p7zip-full`, kind: `apt`, step: `RUN apt-get install -y p7zip-full`, drafted: true });

const decisions: [string, string][] = [];
let app: App | undefined;

const mount = (entries: EnvironmentRecurring[], canOperate = true): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(RuntimeInstalls, {
                entries,
                canOperate,
                busy: false,
                onDecide: (tool: string, decision: string) => decisions.push([tool, decision]),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// Rows are an accordion: everything but the headline, verbs included, sits behind the row's own chevron.
const openRow = async (el: HTMLElement, index = 0): Promise<void> => {
    (el.querySelectorAll(`button[aria-expanded]`)[index] as HTMLElement | undefined)?.click();
    await nextTick();
};

const verbs = (el: HTMLElement): string[] =>
    // The header's fold isn't a row verb; it's the one button carrying `aria-pressed`, filtered out here.
    [...el.querySelectorAll(`button:not([aria-pressed])`)]
        .map((button) => button.textContent?.trim() ?? ``)
        .filter((label) => label !== ``)
        .filter((label) => !label.startsWith(`chromium`) && !label.startsWith(`zizmor`) && !label.startsWith(`p7zip`));

// The header press that reveals dismissed rows.
const unfold = async (el: HTMLElement): Promise<void> => {
    (el.querySelector(`button[aria-pressed]`) as HTMLElement | undefined)?.click();
    await nextTick();
};

afterEach(() => {
    decisions.length = 0;
    started.length = 0;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`heads the list the way the rest of the tab heads a section`, () => {
    const el = mount([TEMPLATABLE, HUMAN]);
    expect(el.textContent).toContain(`Installed at runtime`);
    expect(el.textContent).toContain(`2 items`);
    expect(el.textContent).toContain(`Not in the image`);
    expect(el.textContent).not.toContain(`playwright install --with-deps`);
});

it(`offers the deterministic fix where a step follows from the package name`, async () => {
    const el = mount([TEMPLATABLE]);
    await openRow(el);
    expect(el.textContent).toContain(`npx --yes playwright install --with-deps chromium-headless-shell`);
    expect(verbs(el)).toContain(`Add to the image`);
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(false);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add to the image`))?.click();
    expect(decisions).toEqual([[`chromium-headless-shell`, `adopt`]]);
});

it(`hands the routing decision to an agent where no template can make it`, async () => {
    const el = mount([HUMAN]);
    await openRow(el);
    expect(el.textContent).toContain(`virtualenv`);
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(true);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Ask an agent`))?.click();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(`\`zizmor\` (pip)`);
    expect(started[0]).toContain(`3 sessions`);
    expect(started[0]).toContain(`.intentic/config/environment.d/zizmor.Dockerfile`);
});

it(`dismisses one entry, and lets that be undone`, async () => {
    const el = mount([HUMAN]);
    await openRow(el);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Dismiss`)?.click();
    expect(decisions).toEqual([[`zizmor`, `dismiss`]]);

    app?.unmount();
    document.body.innerHTML = ``;
    decisions.length = 0;
    const dismissed = mount([{ ...HUMAN, declined: true }]);
    await unfold(dismissed);
    await openRow(dismissed);
    expect(dismissed.textContent).toContain(`Dismissed.`);
    expect(verbs(dismissed)).toContain(`Undo`);
    expect(verbs(dismissed).some((label) => label.includes(`Ask an agent`))).toBe(false);
    [...dismissed.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Undo`)?.click();
    expect(decisions).toEqual([[`zizmor`, `restore`]]);
});

it(`folds an answered row out of the list, and out of the count`, async () => {
    const el = mount([TEMPLATABLE, { ...HUMAN, declined: true }]);
    expect(el.textContent).toContain(`chromium-headless-shell`);
    expect(el.textContent).not.toContain(`zizmor`);
    expect(el.textContent).toContain(`1 item`);
    expect(el.textContent).toContain(`1 dismissed`);

    await unfold(el);
    expect(el.textContent).toContain(`zizmor`);
    expect([...el.querySelectorAll(`button[aria-expanded]`)].map((row) => row.textContent?.includes(`zizmor`))).toEqual([false, true]);
    expect(el.textContent).toContain(`1 item`);
});

it(`says nothing of a list whose every entry is answered`, async () => {
    const el = mount([
        { ...HUMAN, declined: true },
        { ...TEMPLATABLE, declined: true },
    ]);
    expect(el.querySelectorAll(`button[aria-expanded]`)).toHaveLength(0);
    expect(el.textContent).not.toContain(`item`);
    expect(el.textContent).not.toContain(`Not in the image`);
    expect(el.textContent).toContain(`2 dismissed`);
    await unfold(el);
    expect(el.querySelectorAll(`button[aria-expanded]`)).toHaveLength(2);
});

it(`asks nothing of an entry already waiting in the proposal above`, async () => {
    const el = mount([DRAFTED]);
    expect(el.textContent).toContain(`proposed`);
    await openRow(el);
    expect(el.textContent).toContain(`waiting for your approval`);
    expect(verbs(el)).not.toContain(`Add to the image`);
    expect(verbs(el)).toContain(`Dismiss`);
});

it(`offers a member the agent but none of the owner's decisions`, async () => {
    const el = mount([TEMPLATABLE, HUMAN], false);
    await openRow(el, 0);
    await openRow(el, 1);
    expect(verbs(el)).not.toContain(`Add to the image`);
    expect(verbs(el)).not.toContain(`Dismiss`);
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(true);
});
