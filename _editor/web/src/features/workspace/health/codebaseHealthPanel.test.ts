// @vitest-environment jsdom
// Pins the refactor action's wiring: one per hotspot row, none for an ordinary key module, and a press carries
// that row's own prompt. Arithmetic is covered in refactorAsk.test.ts.
import { beforeAll, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import type { WorkspaceHealth } from "@intentic/api-contract";
import CodebaseHealth from "./CodebaseHealth.vue";
import { IconStub } from "@intentic/ui/testing";

// Hoisted so the static import avoids the TDZ; matchMedia stays false, keeping the device desktop.
const mocked = vi.hoisted(() => {
    return { started: [] as string[], health: { value: undefined as WorkspaceHealth | undefined } };
});
const { started, health } = mocked;

vi.mock(`../../agents/fleet/agentActions`, () => ({ startAgent: (prompt?: string) => mocked.started.push(prompt ?? ``) }));
vi.mock(`./useCodebaseHealth`, () => ({
    useCodebaseHealth: () => ({ health: mocked.health, loading: ref(false), error: ref(null), refresh: () => {} }),
}));
vi.mock(`../explorer/useRepos`, () => ({ useRepos: () => ({ options: ref([`root`]) }) }));

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(CodebaseHealth, { repo: `root` }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const NOW = Date.now();
const DAY_MS = 86_400_000;

// One hotspot of each shape, plus a key-module list with a healthy chokepoint beside a god module.
const report: WorkspaceHealth = {
    repo: `root`,
    totals: { files: 400, symbols: 5_000, complexity: 3_600, hotspots: 42 },
    hotspots: [
        { path: `src/conversation.ts`, commits: 60, adds: 4_120, dels: 1_877, complexity: 203, score: 12_180, latestMs: NOW - DAY_MS },
        { path: `src/legacy/parser.ts`, commits: 4, adds: 90, dels: 12, complexity: 180, score: 720, latestMs: NOW - 400 * DAY_MS },
        { path: `src/schemas.ts`, commits: 40, adds: 900, dels: 200, complexity: 12, score: 480, latestMs: NOW - 2 * DAY_MS },
    ],
    // Peer group: median of these ordinary modules is what makes schemas.ts an outlier, not just the largest of two.
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
    // index.ts exports four symbols, an ordinary shape, so it gets no refactor invitation.
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

    // src/schemas.ts churns and the import graph leans on it, hence two different asks below.
    refactorButtons(el)[2]!.click();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(`src/schemas.ts`);
    expect(started[0]).toContain(String(report.hotspots[2]!.commits));

    // The key-module row for the same path is a different ask about the same file: its surface, not its churn.
    refactorButtons(el)[3]!.click();
    expect(started).toHaveLength(2);
    expect(started[1]).toContain(String(report.modules[1]!.exports));
    expect(started[1]).not.toBe(started[0]);
});

it(`dims the row nobody has touched in a season instead of hiding it`, async () => {
    const el = mount();
    await nextTick();
    const [live, dormant] = refactorButtons(el);
    expect(dormant!.className).toContain(`text-subtle`);
    expect(live!.className).not.toContain(`text-subtle`);
    // Dimmed, not disabled: the button still sends, since the git log is evidence, not a veto.
    started.length = 0;
    dormant!.click();
    expect(started[0]).toContain(`src/legacy/parser.ts`);
    expect(started[0]).toContain(String(report.hotspots[1]!.commits));
});
