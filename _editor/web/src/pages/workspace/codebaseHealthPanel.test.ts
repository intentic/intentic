// @vitest-environment jsdom
//
// The panel's REFACTOR AFFORDANCE, pressed rather than reasoned about. The arithmetic that picks each row's
// archetype is covered in refactorAsk.test.ts; what this pins is the wiring the template owns and a unit test
// cannot see: that the action exists once per hotspot row, that a key module with an ordinary surface offers
// none, and that a press carries THAT row's composed prompt into a new agent. The row was a single button
// before this — one cannot nest inside another, so the markup had to be restructured, and a regression there
// looks like a panel that renders perfectly and does nothing.
import { beforeAll, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import type { WorkspaceHealth } from "@intentic-app/api-contract";
import CodebaseHealth from "./CodebaseHealth.vue";

/* The mocks' state is hoisted rather than declared below the imports, so the component can be imported
 * statically: a vi.mock factory runs at the mocked module's first import, and with a static import of the panel
 * that happens while a module-scope `const` is still in its temporal dead zone. Held here it is initialised
 * first, and the panel's whole subtree loads during collection instead of inside a hook, where it was ~1s of a
 * hook budget (see vitest.config.ts).
 *
 * `matchMedia` comes from vitest.setup.ts: ui's useDevice reads it at module scope, and its matches:false keeps
 * the device DESKTOP, where the refactor action is hover-revealed. `started` is every prompt a press handed to
 * the fleet — the action itself
 * is covered in agentActions.test.ts, so the seam is mocked and this test says nothing about turns. One repo,
 * so the header renders its name rather than the Picker (a PrimeVue overlay this test has no use for). */
const mocked = vi.hoisted(() => {
    return { started: [] as string[], health: { value: undefined as WorkspaceHealth | undefined } };
});
const { started, health } = mocked;

vi.mock(`../../composables/agents/agentActions`, () => ({ startAgent: (prompt?: string) => mocked.started.push(prompt ?? ``) }));
vi.mock(`../../composables/workspace/useCodebaseHealth`, () => ({
    useCodebaseHealth: () => ({ health: mocked.health, loading: ref(false), error: ref(null), refresh: () => {} }),
}));
vi.mock(`../../composables/workspace/useRepos`, () => ({ useRepos: () => ({ options: ref([`root`]) }) }));

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(CodebaseHealth, { repo: `root` }) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const NOW = Date.now();
const DAY_MS = 86_400_000;

// A report with one hotspot of each shape the panel can meet, and a key-module list holding a healthy
// chokepoint beside a god module.
const report: WorkspaceHealth = {
    repo: `root`,
    totals: { files: 400, symbols: 5_000, complexity: 3_600, hotspots: 42 },
    hotspots: [
        { path: `src/conversation.ts`, commits: 60, adds: 4_120, dels: 1_877, complexity: 203, score: 12_180, latestMs: NOW - DAY_MS },
        { path: `src/legacy/parser.ts`, commits: 4, adds: 90, dels: 12, complexity: 180, score: 720, latestMs: NOW - 400 * DAY_MS },
        { path: `src/schemas.ts`, commits: 40, adds: 900, dels: 200, complexity: 12, score: 480, latestMs: NOW - 2 * DAY_MS },
    ],
    // A peer group, because "wide" is measured against one: the median of these ordinary modules is what makes
    // schemas.ts an outlier rather than just the largest of two.
    modules: [
        { path: `src/index.ts`, exports: 4 },
        { path: `src/schemas.ts`, exports: 428 },
        { path: `src/client.ts`, exports: 18 },
        { path: `src/routes.ts`, exports: 22 },
        { path: `src/util.ts`, exports: 12 },
    ],
    freshness: { state: `fresh` },
};

const refactorButtons = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll<HTMLButtonElement>(`button`)].filter((button) => button.getAttribute(`aria-label`)?.startsWith(`Refactor `));

beforeAll(() => {
    health.value = report;
});

it(`offers one refactor per hotspot row, and only the wide key module`, async () => {
    const el = mount();
    await nextTick();
    // Three hotspots + the god module. index.ts exports four symbols: the shape you want, so no invitation.
    expect(refactorButtons(el).map((button) => button.getAttribute(`aria-label`))).toEqual([
        `Refactor conversation.ts`,
        `Refactor parser.ts`,
        `Refactor schemas.ts`,
        `Refactor schemas.ts`,
    ]);
});

it(`sends the pressed row's own prompt, and nothing else`, async () => {
    const el = mount();
    await nextTick();
    started.length = 0;

    // The load-bearing hotspot: src/schemas.ts churns AND the import graph leans on it.
    refactorButtons(el)[2]!.click();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(`Refactor src/schemas.ts.`);
    expect(started[0]).toContain(`40 commits over all history`);
    expect(started[0]).toContain(`Separate the contract from the churn`);

    // The key-module row for the same path is a different ask about the same file: its surface, not its churn.
    refactorButtons(el)[3]!.click();
    expect(started).toHaveLength(2);
    expect(started[1]).toContain(`428 exports`);
});

it(`dims the row nobody has touched in a season instead of hiding it`, async () => {
    const el = mount();
    await nextTick();
    const [live, dormant] = refactorButtons(el);
    expect(dormant!.className).toContain(`text-subtle`);
    expect(live!.className).not.toContain(`text-subtle`);
    // The reason lives in the tooltip; the button still sends, because the git log is evidence, not a veto.
    started.length = 0;
    dormant!.click();
    expect(started[0]).toContain(`Refactor src/legacy/parser.ts.`);
});
