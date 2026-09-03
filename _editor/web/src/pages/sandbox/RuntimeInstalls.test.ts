// @vitest-environment jsdom
//
// THE SUBJECT IS WHETHER A ROW ENDS SOMEWHERE. This list shipped as a caption over a bare <ul> of
// `tool · 2 sessions · proposed`, and the state it describes is one the daemon can reach and then not leave:
// an install it has recorded, corroborated against the live container, and has no mechanical template for
// sits there being reported, forever, with no press anywhere on the card that answers it. This workspace's own
// `chromium-headless-shell` did exactly that for six days.
//
// So what is pinned is the VERBS, per state, because that is the whole change: a templatable entry can be
// added, an untemplatable one can be handed to an agent, and either can be dismissed — which until now was
// reachable only as a side effect of rejecting an entire proposal.
import type { EnvironmentRecurring } from "@intentic-app/api-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The brand CDN is stubbed to refuse, exactly as an offline sandbox answers: every mark paints its glyph tier
// and nothing here waits on a round trip.
vi.hoisted(() => {
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch;
});

// Starting a turn summons a chat tab through app-wide singletons; the press is what this suite is about.
const started: string[] = [];
vi.mock(`../../composables/agents/agentActions`, () => ({ startAgent: (prompt: string) => started.push(prompt) }));

const { default: RuntimeInstalls } = await import("./RuntimeInstalls.vue");

const entry = (over: Partial<EnvironmentRecurring> & Pick<EnvironmentRecurring, "tool" | "kind">): EnvironmentRecurring => ({
    sessions: 2,
    lastAt: Date.parse(`2026-09-03T00:00:00Z`),
    live: true,
    ...over,
});

// One of each state the list can be in: a mechanical step nobody has taken yet, an ecosystem with no step at
// all, and one already folded into the proposal above.
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
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// The rows are an accordion: everything below the headline, verbs included, is behind the row's own chevron.
const openRow = async (el: HTMLElement, index = 0): Promise<void> => {
    (el.querySelectorAll(`button[aria-expanded]`)[index] as HTMLElement | undefined)?.click();
    await nextTick();
};

const verbs = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`button`)]
        .map((button) => button.textContent?.trim() ?? ``)
        .filter((label) => label !== ``)
        .filter((label) => !label.startsWith(`chromium`) && !label.startsWith(`zizmor`) && !label.startsWith(`p7zip`));

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
    // The count is a count of items, not of the sessions beside it: a bare "2" between "playwright" and
    // "2 sessions" reads as one more of those.
    expect(el.textContent).toContain(`Not in the image`);
    // Closed rows cost one line each: the step, the reasoning and the verbs are all behind the chevron.
    expect(el.textContent).not.toContain(`playwright install --with-deps`);
});

it(`offers the deterministic fix where a step follows from the package name`, async () => {
    const el = mount([TEMPLATABLE]);
    await openRow(el);
    // The step is shown, not just promised: the difference between a button you can judge and one you trust.
    expect(el.textContent).toContain(`npx --yes playwright install --with-deps chromium-headless-shell`);
    expect(verbs(el)).toContain(`Add to the image`);
    // And no agent is spent on a question a template already answers.
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(false);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add to the image`))?.click();
    expect(decisions).toEqual([[`chromium-headless-shell`, `adopt`]]);
});

it(`hands the routing decision to an agent where no template can make it`, async () => {
    const el = mount([HUMAN]);
    await openRow(el);
    // The reason is the ecosystem's, not a shrug: it is what the reader needs to judge the agent's answer.
    expect(el.textContent).toContain(`virtualenv`);
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(true);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Ask an agent`))?.click();
    // The brief carries what the turn cannot recover: which tool, which ecosystem, how often, where to write.
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
    await openRow(dismissed);
    expect(dismissed.textContent).toContain(`dismissed`);
    // A dismissal a mis-click can reach is one that has to be reversible, and nothing else is offered on it.
    expect(verbs(dismissed)).toContain(`Undo`);
    expect(verbs(dismissed).some((label) => label.includes(`Ask an agent`))).toBe(false);
    [...dismissed.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Undo`)?.click();
    expect(decisions).toEqual([[`zizmor`, `restore`]]);
});

it(`asks nothing of an entry already waiting in the proposal above`, async () => {
    const el = mount([DRAFTED]);
    expect(el.textContent).toContain(`proposed`);
    await openRow(el);
    expect(el.textContent).toContain(`waiting for your approval`);
    expect(verbs(el)).not.toContain(`Add to the image`);
    // Dismiss survives: approving is not the only answer, and rejecting the whole proposal is too blunt a way
    // to say "not this one".
    expect(verbs(el)).toContain(`Dismiss`);
});

it(`offers a member the agent but none of the owner's decisions`, async () => {
    const el = mount([TEMPLATABLE, HUMAN], false);
    await openRow(el, 0);
    await openRow(el, 1);
    expect(verbs(el)).not.toContain(`Add to the image`);
    expect(verbs(el)).not.toContain(`Dismiss`);
    // Asking an agent is not an owner-gated write: it opens a chat, which any member can already do.
    expect(verbs(el).some((label) => label.includes(`Ask an agent`))).toBe(true);
});
