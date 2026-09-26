import "@intentic/testing/dom";
import { type Finding, type MainlineProject, type MainlinePush, type MainlineRun, type MainlineStatus, pushFixBase, type Red } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import type { PushFixAttempt } from "./useMainline";

const opened = jest.fn((_conversationId: string, _title?: string) => undefined);
const watched = jest.fn((_session: string) => undefined);
// The owner's hands on what a push left: each answers as the daemon would, and the suite reads what it was asked.
const dismissed = jest.fn(async (_project: string, ids?: readonly string[], _restore?: boolean) => ids?.length ?? 0);
const rechecked = jest.fn(async (_project: string) => ({ measured: true, resolved: 2, open: 5 }));
const handed = jest.fn(async (_project: string, _pick?: unknown, _mode?: unknown) => `push-fix-intentic-0abc123`);
// The hand-over's live attempt as the roster would report it; none unless a test puts one there.
const attemptOnIt = ref<PushFixAttempt | undefined>(undefined);
// What the view's read answers, and whether the daemon serves the route at all.
const served = ref<MainlineStatus | undefined>(undefined);
const routeServed = ref(true);

// The run button is its own suite's: here it is a button that says its label and runs on a press. The board is measured
// wide, three lanes side by side, as the fleet board's suite stands it up.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        Notice: vue.defineComponent({ setup: (_props, { slots }) => () => vue.h(`div`, { role: `status` }, slots[`default`]?.()) }),
        AgentRunButton: vue.defineComponent({
            props: { label: { type: String, required: true } },
            emits: [`run`],
            setup: (props, { emit }) => () => vue.h(`button`, { type: `button`, "data-run": ``, onClick: () => emit(`run`) }, props.label),
        }),
        fixStanceLook: () => ({ icon: `spinner`, spin: true, ink: `text-info`, chip: `` }),
        useAgentRunPick: () => ({
            model: vue.computed(() => ({ provider: `claude`, model: `opus`, label: `Opus` })),
            overridden: vue.computed(() => false),
            resume: vue.computed(() => undefined),
            choose: async () => false,
            clear: () => undefined,
        }),
        useNarrow: () => vue.ref(false),
        ui: {
            iconButton: (extra: string) => extra,
            linkButton: (extra: string) => extra,
            textAction: (extra: string) => extra,
            addTile: (extra: string) => extra,
            sectionLabelSm: (extra: string) => extra,
            emptyState: (extra = ``) => extra,
        },
    };
});
jest.mock("./useMainline", () => ({
    useMainline: () => computed(() => served.value),
    dismissPushFindings: dismissed,
    recheckPushFindings: rechecked,
    handPushFindings: handed,
    usePushFixAttempt: () => computed(() => attemptOnIt.value),
}));
jest.mock("../../sandbox/overview/useDaemonRoutes", () => ({ supportsRoute: (_name: string) => routeServed.value }));
jest.mock("../../chat/models/shellModelPicking", () => ({ shellModelPicking: () => ({}) }));
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({ agentById: (id: string) => (id === `land-fix-web-abc` ? { title: `Fix main after "Release notes"` } : undefined) }),
}));
jest.mock("./openLanded", () => ({
    openLandConversation: opened,
    useLandTitle: () => (conversationId: string, title?: string) =>
        title ?? (conversationId === `land-fix-web-abc` ? `Fix main after "Release notes"` : conversationId),
}));
jest.mock("../../terminal/useWorkTerminals", () => ({ openWorkTerminal: watched }));

const { default: Mainline } = await import("./Mainline.vue");
const { sinceWhen } = await import("./mainlineView");
const { useNotifications } = await import("../../../shell/notifications/notifications");
const { SandboxHttpError } = await import("../../sandbox/client/sandboxHttpError");

const NOW = 10_000_000_000;
const MINUTE = 60_000;

let app: App | undefined;

// The view as the rail opens it: its read answers `status`. A router always, since an older sandbox's note links to the
// sandbox page's Update card.
const mount = (status: MainlineStatus | undefined): HTMLElement => {
    served.value = status;
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(Mainline) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] }));
    app.mount(element);
    return element;
};

// An element's text pieces joined by a space, as they read; the compiled template keeps no whitespace between them.
const wordsOf = (node: Node | null | undefined): string =>
    node === null || node === undefined
        ? ``
        : [...node.childNodes]
              .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? ``) : wordsOf(child)).trim())
              .filter((piece) => piece !== ``)
              .join(` `);

const lanes = (element: HTMLElement): string[] => [...element.querySelectorAll<HTMLElement>(`[data-lane]`)].map((lane) => lane.dataset[`lane`] ?? ``);
const lane = (element: HTMLElement, id: string): HTMLElement => element.querySelector<HTMLElement>(`[data-lane="${id}"]`)!;
// A lane's own header, the fleet board's (LaneHeader): its name, and its count or its door.
const laneHead = (element: HTMLElement, id: string): string => wordsOf(lane(element, id).querySelector(`header`));
const summaryOf = (element: HTMLElement): HTMLElement => element.querySelector<HTMLElement>(`[data-summary]`)!;
const buttonNamed = (within: HTMLElement, words: string): HTMLButtonElement =>
    [...within.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => wordsOf(button) === words)!;

const green = (over: Partial<MainlineRun> = {}): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `green`,
    startedAt: NOW - 14 * MINUTE,
    at: NOW - 12 * MINUTE,
    lands: [{ conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 15 * MINUTE }],
    failures: [],
    failureCount: 0,
    attempt: 0,
    ...over,
});

const RED: MainlineRun = {
    ...green(),
    status: `red`,
    at: NOW - 31 * MINUTE,
    lands: [{ conversationId: `notes`, title: `Release notes`, at: NOW - 34 * MINUTE }],
    failures: [`web/src/pages/changelog.test.ts › lists every release`, `web/src/pages/changelog.test.ts › links each tag`],
    units: [
        { name: `lists every release`, path: `web/src/pages/changelog.test.ts` },
        { name: `links each tag`, path: `web/src/pages/changelog.test.ts` },
    ],
    failureCount: 2,
    attempt: 1,
    suspects: [`notes`],
    named: true,
    routing: { kind: `fix-up`, conversationId: `land-fix-web-abc`, at: NOW - 30 * MINUTE, detail: `Its conversation had gone cold.` },
};

// A red project as a current daemon lays it: at the run's suspects, with its latest decision, and its check's terminal.
const redProject = (run: MainlineRun, over: Partial<MainlineProject> = {}): MainlineProject => {
    const red: NonNullable<MainlineProject[`red`]> = {
        since: run.at,
        cause: run.lands.filter((each) => run.suspects?.includes(each.conversationId) === true).map(({ conversationId, title }) => ({ conversationId, title })),
        named: true,
    };
    if (run.routing !== undefined) {
        red.fixer = run.routing;
    }
    return { project: run.project, queued: [], session: `panel-${run.project}--verify`, last: run, redSince: run.at, red, ...over };
};

const redStatus = (): MainlineStatus => ({
    projects: [redProject(RED, { queued: [{ conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 40_000 }] })],
    recent: [RED, green({ at: NOW - 90 * MINUTE })],
    reds: [],
});

const runningStatus = (): MainlineStatus => ({
    projects: [
        {
            project: `web`,
            running: {
                command: `pnpm verify`,
                startedAt: NOW - 65_000,
                lands: [
                    { conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 70_000 },
                    { conversationId: `copy`, title: `Tighten the pricing copy`, at: NOW - 69_000 },
                ],
            },
            queued: [],
            session: `panel-web--verify`,
            last: green(),
        },
    ],
    recent: [green()],
    reds: [],
});

// What the real case left: two commits pushed to main, seven findings, the tree's own breakage among them.
const leftFinding = (id: string, check: string, gate: `code` | `tidy`, text: string): Finding => ({
    id,
    source: check,
    recheckable: true,
    gate,
    text,
    command: `node _tools/checks/run.mjs --only ${check}`,
});

const LEFT: Finding[] = [
    leftFinding(`paths-1`, `paths`, `tidy`, `_sandbox/sandbox/src/workspace/files/workspace-trash.integration.test.ts:8  spells the state dir`),
    leftFinding(`silent-1`, `silent-catch`, `tidy`, `_sandbox/sandbox/src/workspace/files/workspace-trash.ts:127  .catch discards the error`),
    leftFinding(`silent-2`, `silent-catch`, `code`, `_sandbox/sandbox/src/workspace/files/workspace-trash.ts: 3 silent catch(es), the baseline allows 0`),
    leftFinding(`layout-1`, `layout`, `code`, `_editor/web/src/features/workspace/explorer: 36 files, the baseline allows 33`),
    leftFinding(`layout-2`, `layout`, `code`, `_sandbox/sandbox/src/workspace/files: 32 files`),
    leftFinding(`daemon-1`, `daemon-boundaries`, `code`, `portability -> settings closes a cycle`),
    leftFinding(`buttons-1`, `buttons`, `tidy`, `_editor/web/src/features/agents/metrics/SandboxMetricsDetails.vue:29  a bare <button>`),
];

const PUSHED: MainlinePush = {
    project: `intentic`,
    id: `push-725e054`,
    at: NOW - 20 * MINUTE,
    remote: `origin`,
    branch: `main`,
    base: `6c6a13a392`,
    head: `725e054fb6`,
    commits: 2,
    findings: LEFT,
};

const CLEAN_PUSH: MainlinePush = { ...PUSHED, id: `push-6c6a13a`, at: NOW - 300 * MINUTE, head: `6c6a13a392`, commits: 1, findings: [] };

// What the project owes of it: everything the push found.
const LEFT_RED: Red = { source: `push`, scope: `intentic`, since: PUSHED.at, findings: LEFT, suspects: [], named: false, decisions: [] };

const pushedStatus = (): MainlineStatus => ({
    projects: [{ project: `web`, queued: [], last: green() }],
    recent: [green()],
    pushed: [PUSHED, CLEAN_PUSH],
    reds: [LEFT_RED],
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    opened.mockClear();
    watched.mockClear();
    dismissed.mockClear();
    rechecked.mockClear();
    handed.mockClear();
    attemptOnIt.value = undefined;
    routeServed.value = true;
    useNotifications().dismissReceipt();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

describe(`the Main line view`, () => {
    it(`opens onto a board of the road a land travels, queued, checking, result, under a header that says how main stands`, () => {
        const element = mount(redStatus());
        expect(wordsOf(summaryOf(element))).toBe(`web failing · fixing 1 queued`);
        expect(summaryOf(element).getAttribute(`aria-label`)).toBe(`Main line status`);
        // Nothing in it is explained on hover: the page carries no note.
        expect(element.querySelector(`[role="note"]`)).toBeNull();
        expect(lanes(element)).toEqual([`queued`, `checking`, `result`]);
        expect(laneHead(element, `queued`)).toBe(`Queued 1`);
        expect(wordsOf(lane(element, `checking`))).toBe(`Checking No check running`);
        // The Result lane's door to the record is its header's chip, counting what is behind it.
        expect(laneHead(element, `result`)).toBe(`Result 2`);
        expect(lane(element, `result`).querySelector(`[data-history]`)?.getAttribute(`aria-label`)).toBe(`Open the history (2)`);
    });

    it(`says nothing was checked yet in place of an empty board, while nothing was and before the read answers`, () => {
        const element = mount(undefined);
        expect(wordsOf(element.querySelector(`[data-empty]`))).toBe(`Nothing checked yet. When work lands, its check on the main tree shows here.`);
        expect(element.querySelector(`[data-lane]`)).toBeNull();
        expect(element.querySelector(`[data-summary]`)).toBeNull();
        app?.unmount();

        const nothing = mount({ projects: [], recent: [], reds: [] });
        expect(nothing.querySelector(`[data-empty]`)).not.toBeNull();
    });

    it(`says the sandbox needs an update, not that nothing was checked, when it does not serve the main line at all`, () => {
        routeServed.value = false;
        const element = mount(undefined);
        expect(wordsOf(element.querySelector(`[data-outdated]`))).toContain(
            `Until it updates, this sandbox can't show the check its main tree gets after each land.`,
        );
        expect(element.querySelector(`[data-empty]`)).toBeNull();
    });
});

// What the board's status bar used to say at rest, now the view's header: read at a glance, above the lanes.
describe(`the view's header, at rest`, () => {
    // Health and activity side by side; what the check runs and whose work it measures are the lanes' to say.
    it(`says whether main passes and what the check is doing, in two short answers`, async () => {
        const element = mount(runningStatus());
        expect(wordsOf(summaryOf(element))).toBe(`Main passing Checking web 1m 5s`);
        expect(wordsOf(summaryOf(element).querySelector(`[data-item="health"]`))).toBe(`Main passing`);
        expect(wordsOf(summaryOf(element).querySelector(`[data-item="running"]`))).toBe(`Checking web 1m 5s`);
        expect(summaryOf(element).textContent).not.toContain(`pnpm verify`);
        expect(summaryOf(element).textContent).not.toContain(`Add Stripe checkout`);

        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(wordsOf(summaryOf(element).querySelector(`[data-item="running"]`))).toBe(`Checking web 1m 6s`);
    });

    it(`says which project fails and who has it, with nothing to press beside it`, () => {
        const element = mount(redStatus());
        expect(wordsOf(summaryOf(element).querySelector(`[data-item="health"]`))).toBe(`web failing · fixing`);
        expect(wordsOf(summaryOf(element).querySelector(`[data-item="queued"]`))).toBe(`1 queued`);
        expect(summaryOf(element).querySelectorAll(`a, button`)).toHaveLength(0);
    });

    it(`asks for the reader's eye only when a red waits for them`, () => {
        const spent: MainlineRun = { ...RED, routing: { kind: `spent`, at: NOW - 5 * MINUTE, detail: `Still red after 2 fresh attempt(s); it waits for you.` } };
        const element = mount({ projects: [redProject(spent)], recent: [spent], reds: [] });
        const health = summaryOf(element).querySelector(`[data-item="health"]`)!;
        expect(wordsOf(health)).toBe(`web failing · needs you`);
        expect(health.querySelector(`.text-warning`)?.textContent?.trim()).toBe(`· needs you`);
        app?.unmount();

        const fixing = mount(redStatus());
        expect(summaryOf(fixing).querySelector(`.text-warning`)).toBeNull();
    });

    it(`counts the projects failing when there is more than one, and keeps a red on the line while another check runs`, () => {
        const apiRed: MainlineRun = { ...RED, project: `api`, at: NOW - 20 * MINUTE, routing: undefined };
        const status = redStatus();
        const element = mount({
            projects: [...status.projects, redProject(apiRed, { running: { command: `pnpm test`, startedAt: NOW - 5_000, lands: [] } })],
            recent: [apiRed, ...status.recent],
            reds: [],
        });
        expect(wordsOf(summaryOf(element))).toBe(`2 projects failing Checking api 5s 1 queued`);
    });

    it(`says main passes once something was checked, and nothing about health before`, () => {
        const element = mount({ projects: [{ project: `web`, queued: [], last: green() }], recent: [green()], reds: [] });
        expect(wordsOf(summaryOf(element))).toBe(`Main passing`);
        app?.unmount();

        const first = mount({ projects: [{ project: `web`, running: { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] }, queued: [] }], recent: [], reds: [] });
        expect(wordsOf(summaryOf(first))).toBe(`Checking web 5s`);
        expect(first.querySelector(`[data-item="health"]`)).toBeNull();
    });

    it(`counts the lands queued for the next check, each once`, () => {
        const waiting = { conversationId: `a`, at: NOW - 5_000 };
        const element = mount({
            projects: [
                { project: `web`, queued: [waiting, { conversationId: `b`, at: NOW - 3_000 }], last: green() },
                // The same land waiting in a second project is still one land.
                { project: `api`, queued: [waiting] },
            ],
            recent: [green()],
            reds: [],
        });
        expect(wordsOf(summaryOf(element))).toBe(`Main passing 2 queued`);
        // The lane counts it once too, and draws it in each queue it waits in.
        expect(laneHead(element, `queued`)).toBe(`Queued 2`);
        expect([...lane(element, `queued`).querySelectorAll<HTMLElement>(`[data-queue]`)].map((queue) => queue.dataset[`queue`])).toEqual([`web`, `api`]);
    });

    it(`counts what pushes left in amber beside main passing, which it never takes off the header`, () => {
        const element = mount(pushedStatus());
        expect(wordsOf(summaryOf(element))).toBe(`Main passing 7 left at push`);
        expect(summaryOf(element).querySelector(`[data-item="push"]`)?.className).toBe(`flex shrink-0 items-center gap-1.5 text-warning`);
    });
});

describe(`the Queued lane`, () => {
    it(`draws each project's queue as a card with its lands hung under it, newest first, each opening its conversation`, async () => {
        const status = redStatus();
        const element = mount({
            ...status,
            projects: [{ ...status.projects[0]!, queued: [{ conversationId: `copy`, title: `Tighten the pricing copy`, at: NOW - 5 * MINUTE }, ...status.projects[0]!.queued] }],
        });
        const queue = lane(element, `queued`).querySelector<HTMLElement>(`[data-queue="web"]`)!;
        expect(wordsOf(queue.querySelector(`article`))).toBe(`web 2 lands wait for the next check`);
        // Aged from the minute the board reads, 40s before NOW: the one that landed 40s ago reads as now.
        const rows = [...queue.querySelectorAll<HTMLButtonElement>(`[data-land]`)];
        expect(rows.map((row) => wordsOf(row))).toEqual([`Add Stripe checkout now`, `Tighten the pricing copy 4m ago`]);
        expect(queue.querySelector(`[role="group"]`)?.getAttribute(`aria-label`)).toBe(`Lands waiting in web`);

        rows[0]!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`checkout`, `Add Stripe checkout`);
        expect(lane(element, `queued`)).not.toBeNull();
    });

    // The lane stays a board of cards: a long queue folds as the fleet board folds finished subagents.
    it(`folds a queue past five lands, one more never folds, and the rest open in place`, async () => {
        const landing = (count: number): MainlineStatus => ({
            projects: [
                {
                    project: `web`,
                    queued: Array.from({ length: count }, (_, at) => ({ conversationId: `land-${at + 1}`, title: `Land ${at + 1}`, at: NOW - (at + 1) * MINUTE })),
                    last: green(),
                },
            ],
            recent: [green()],
            reds: [],
        });
        const element = mount(landing(8));
        const rows = (): string[] => [...lane(element, `queued`).querySelectorAll(`[data-land]`)].map((row) => wordsOf(row).split(` `).slice(0, 2).join(` `));
        const fold = lane(element, `queued`).querySelector<HTMLButtonElement>(`[data-fold]`)!;
        expect(rows()).toEqual([`Land 1`, `Land 2`, `Land 3`, `Land 4`, `Land 5`]);
        expect(wordsOf(fold)).toBe(`+3 more`);
        expect(fold.getAttribute(`aria-expanded`)).toBe(`false`);

        fold.click();
        await nextTick();
        expect(rows()).toHaveLength(8);
        expect(wordsOf(fold)).toBe(`Show fewer`);
        app?.unmount();

        const six = mount(landing(6));
        expect(six.querySelectorAll(`[data-land]`)).toHaveLength(6);
        expect(six.querySelector(`[data-fold]`)).toBeNull();
    });
});

describe(`the Checking lane`, () => {
    it(`draws the running check with its clock and its logs, and the lands it measures hung under it`, async () => {
        const element = mount(runningStatus());
        expect(wordsOf(lane(element, `queued`))).toBe(`Queued Nothing queued`);
        expect(wordsOf(lane(element, `checking`))).toBe(`Checking web Measuring 2 lands 1m 5s Logs Add Stripe checkout Tighten the pricing copy`);
        expect(lane(element, `checking`).querySelector(`[role="group"]`)?.getAttribute(`aria-label`)).toBe(`Lands the check on web is measuring`);

        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(wordsOf(lane(element, `checking`).querySelector(`article`))).toBe(`web Measuring 2 lands 1m 6s Logs`);

        buttonNamed(lane(element, `checking`), `Logs`).click();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
    });

    it(`says where a check sent to another machine runs`, () => {
        const status = runningStatus();
        const element = mount({ ...status, projects: [{ ...status.projects[0]!, running: { ...status.projects[0]!.running!, on: `omen` } }] });
        expect(wordsOf(lane(element, `checking`).querySelector(`[data-meta]`))).toBe(`Measuring 2 lands · on omen`);
    });

    // One terminal per project: while it is being checked again, its Logs sit with the running check.
    it(`opens a project's logs from the running check while it runs, and from its red while it does not`, () => {
        const status = redStatus();
        const checking: MainlineStatus = {
            ...status,
            projects: [{ ...status.projects[0]!, queued: [], running: { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] } }],
        };
        const element = mount(checking);
        expect(buttonNamed(lane(element, `result`), `Logs`)).toBeUndefined();
        buttonNamed(lane(element, `checking`), `Logs`).click();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(wordsOf(lane(element, `checking`))).toBe(`Checking web Re-check 5s Logs`);
    });
});

describe(`the Result lane`, () => {
    it(`says of a failing project who has it, what it is laid at, then what failed, test names first`, () => {
        const element = mount(redStatus());
        const web = lane(element, `result`).querySelector<HTMLElement>(`[data-result="web"]`)!;
        expect(wordsOf(web.firstElementChild)).toBe(`web Failing since ${sinceWhen(RED.at)} Logs`);
        expect(wordsOf(web.querySelector(`[data-fix]`))).toBe(`Being fixed in Fix main after "Release notes"`);
        expect(wordsOf(web.querySelector(`[data-cause]`))).toBe(`Likely cause Release notes`);
        expect([...web.querySelectorAll(`[data-failures] li`)].map((item) => wordsOf(item))).toEqual([
            `lists every release changelog.test.ts`,
            `links each tag changelog.test.ts`,
        ]);
        // Why it went to a fresh conversation is the sandbox's business: nothing the reader has to act on.
        expect(web.textContent).not.toContain(`Its conversation had gone cold.`);
        expect(web.querySelector(`[data-fix]`)?.classList.contains(`text-muted`)).toBe(true);
    });

    // Six before the rest wait behind a press; past the thirty the daemon keeps, the terminal is the place to read.
    it(`lists six of a red's failures, the rest on a press, and counts what only the terminal holds`, async () => {
        const units = Array.from({ length: 12 }, (_, at) => ({ name: `case ${at + 1}`, path: `web/src/pages/changelog.test.ts` }));
        const many: MainlineRun = { ...RED, failures: units.map((unit) => `${unit.path} › ${unit.name}`), units, failureCount: 40 };
        const element = mount({ projects: [redProject(many)], recent: [many], reds: [] });
        const listed = (): string[] => [...lane(element, `result`).querySelectorAll(`[data-failures] li`)].map((item) => wordsOf(item));
        expect(listed()).toEqual([
            `case 1 changelog.test.ts`,
            `case 2 changelog.test.ts`,
            `case 3 changelog.test.ts`,
            `case 4 changelog.test.ts`,
            `case 5 changelog.test.ts`,
            `case 6 changelog.test.ts`,
            `+34 more`,
        ]);

        buttonNamed(lane(element, `result`), `+34 more`).click();
        await nextTick();
        expect(listed()).toHaveLength(14);
        expect(listed().slice(-3)).toEqual([`case 12 changelog.test.ts`, `Show fewer`, `+28 more`]);
    });

    it(`names three of the lands a red is laid at, and the rest on a press`, async () => {
        const lands = Array.from({ length: 5 }, (_, at) => ({ conversationId: `land-${at + 1}`, title: `Land ${at + 1}`, at: NOW - 40 * MINUTE }));
        const wide: MainlineRun = { ...RED, lands, suspects: lands.map((land) => land.conversationId) };
        const element = mount({ projects: [redProject(wide)], recent: [wide], reds: [] });
        const cause = (): string => wordsOf(lane(element, `result`).querySelector(`[data-cause]`));
        expect(cause()).toBe(`Likely cause Land 1 , Land 2 , Land 3 +2 more`);

        buttonNamed(lane(element, `result`), `+2 more`).click();
        await nextTick();
        expect(cause()).toBe(`Likely cause Land 1 , Land 2 , Land 3 , Land 4 , Land 5 Show fewer`);
    });

    it(`gives a red one line on who has it, in the words a reader acts on`, () => {
        const redWith = (routing: MainlineRun[`routing`]): MainlineStatus => {
            const run: MainlineRun = { ...RED, routing };
            return { projects: [redProject(run)], recent: [run], reds: [] };
        };
        interface FixLine {
            readonly words: string;
            readonly tone: string;
            readonly detail: string;
        }
        const lineOf = (routing: MainlineRun[`routing`]): FixLine => {
            const element = mount(redWith(routing));
            const web = lane(element, `result`).querySelector<HTMLElement>(`[data-result="web"]`)!;
            const fix = web.querySelector<HTMLElement>(`[data-fix]`)!;
            const line: FixLine = {
                words: wordsOf(fix),
                tone: [`text-muted`, `text-warning`, `text-success`].find((ink) => fix.classList.contains(ink)) ?? ``,
                detail: wordsOf(web.querySelector(`[data-fix-detail]`)),
            };
            app?.unmount();
            app = undefined;
            document.body.innerHTML = ``;
            return line;
        };
        const at = NOW - 5 * MINUTE;
        expect(lineOf({ kind: `held`, conversationId: `land-fix-web-abc`, at })).toEqual({ words: `Waiting for Fix main after "Release notes"`, tone: `text-muted`, detail: `` });
        expect(lineOf({ kind: `waiting`, at })).toEqual({ words: `Waiting for the next check`, tone: `text-muted`, detail: `` });
        expect(lineOf({ kind: `original`, conversationId: `notes`, at })).toEqual({ words: `Being fixed in notes`, tone: `text-muted`, detail: `` });
        expect(lineOf(undefined)).toEqual({ words: `Deciding who fixes it`, tone: `text-muted`, detail: `` });
        // Left to the reader: the only lines in the warning ink, and the only ones that say why.
        expect(lineOf({ kind: `reported`, at, detail: `Repairs after landing are switched off.` })).toEqual({
            words: `Nobody is fixing it`,
            tone: `text-warning`,
            detail: `Repairs after landing are switched off.`,
        });
        expect(lineOf({ kind: `spent`, at, detail: `Still red after 2 fresh attempt(s); it waits for you.` })).toEqual({
            words: `Out of fix attempts`,
            tone: `text-warning`,
            detail: `Still red after 2 fresh attempt(s); it waits for you.`,
        });
    });

    it(`says a project with nothing failing passes, and what its last check measured`, () => {
        const element = mount(runningStatus());
        expect(wordsOf(lane(element, `result`))).toBe(`Result 1 web passing · Add Stripe checkout 11m ago`);
    });

    // What fails first, what a push left next, what passes last: the order a reader is owed them in.
    it(`orders the lane by what it asks of the reader`, () => {
        const status = redStatus();
        const element = mount({
            projects: [...status.projects, { project: `api`, queued: [], last: green({ project: `api` }) }],
            recent: status.recent,
            pushed: [PUSHED],
            reds: [LEFT_RED],
        });
        const cards = [...lane(element, `result`).querySelectorAll<HTMLElement>(`article`)].map(
            (card) => card.dataset[`result`] ?? card.dataset[`section`] ?? ``,
        );
        expect(cards).toEqual([`web`, `push-intentic`, `api`]);
    });

    // Opened to be watched: a conversation or the logs opened from it leave it standing.
    it(`opens a land's conversation, its fixer's and its logs, and stays standing through each`, async () => {
        const element = mount(redStatus());

        buttonNamed(lane(element, `result`), `Release notes`).click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`notes`, `Release notes`);
        expect(element.querySelector(`[data-lane="result"]`)).not.toBeNull();

        buttonNamed(lane(element, `result`), `Fix main after "Release notes"`).click();
        await nextTick();
        expect(opened).toHaveBeenLastCalledWith(`land-fix-web-abc`);

        buttonNamed(lane(element, `result`), `Logs`).click();
        await nextTick();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(element.querySelector(`[data-lane="result"]`)).not.toBeNull();
    });
});

// THE RECORD, behind the Result lane's header the way the fleet board's archive is behind its Finished lane's.
describe(`the record`, () => {
    it(`opens in the Result lane from its header, newest first, and goes back the same way`, async () => {
        const element = mount(redStatus());
        lane(element, `result`).querySelector<HTMLButtonElement>(`[data-history]`)!.click();
        await nextTick();
        expect(laneHead(element, `result`)).toBe(`History 2`);
        expect([...lane(element, `result`).querySelectorAll<HTMLElement>(`[data-event]`)].map((event) => wordsOf(event))).toEqual([
            `Release notes failed 30m ago`,
            `Add Stripe checkout passed 1h ago`,
        ]);
        expect(lane(element, `result`).querySelector(`[data-result]`)).toBeNull();

        lane(element, `result`).querySelector<HTMLButtonElement>(`button[aria-label="Back to the results"]`)!.click();
        await nextTick();
        expect(laneHead(element, `result`)).toBe(`Result 2`);
        expect(lane(element, `result`).querySelector(`[data-event]`)).toBeNull();
        expect(lane(element, `result`).querySelector(`[data-result="web"]`)).not.toBeNull();
    });

    it(`keeps the whole record the daemon sends, a lane's worth at a time`, async () => {
        const record = Array.from({ length: 14 }, (_, at) => green({ at: NOW - (at + 1) * 60 * MINUTE }));
        const element = mount({ projects: [{ project: `web`, queued: [], last: record[0]! }], recent: record, reds: [] });
        lane(element, `result`).querySelector<HTMLButtonElement>(`[data-history]`)!.click();
        await nextTick();
        expect(lane(element, `result`).querySelectorAll(`[data-event]`)).toHaveLength(12);

        buttonNamed(lane(element, `result`), `2 earlier`).click();
        await nextTick();
        expect(lane(element, `result`).querySelectorAll(`[data-event]`)).toHaveLength(14);
        expect(buttonNamed(lane(element, `result`), `2 earlier`)).toBeUndefined();
    });

    it(`keeps pushes in the record beside the lands' checks, by what each left`, async () => {
        const status = pushedStatus();
        const element = mount({ ...status, pushed: [PUSHED, { ...CLEAN_PUSH, branch: `docs/verify-push` }] });
        lane(element, `result`).querySelector<HTMLButtonElement>(`[data-history]`)!.click();
        await nextTick();
        const events = [...element.querySelectorAll<HTMLElement>(`[data-lane="result"] [data-event]`)];
        // Aged from the minute the board reads, 40s before NOW: 12m reads as 11, 20m as 19, 300m as 4h. Two projects
        // between the lands and the pushes, so every record names its own; a push names its branch only when it is not
        // the one the pushes go to.
        expect(events.map((event) => [event.dataset[`event`], wordsOf(event)])).toEqual([
            [`land`, `Add Stripe checkout passed · web 11m ago`],
            [`push`, `725e054 7 left · intentic 19m ago`],
            [`push`, `6c6a13a → docs/verify-push clean · intentic 4h ago`],
        ]);
    });
});

describe(`what a push left, on the board`, () => {
    it(`lays out what a push left, the tree's own breakage first, eight at a time`, async () => {
        // The case that moved it out of the drawer: fourteen left, the seven above and seven more of one tidy check.
        const more = Array.from({ length: 7 }, (_, at) => leftFinding(`tidy-${at + 1}`, `tidy-lines`, `tidy`, `_editor/web/src/a${at + 1}.ts:1  trailing space`));
        const fourteen = [...LEFT, ...more];
        const element = mount({
            ...pushedStatus(),
            pushed: [{ ...PUSHED, findings: fourteen }, CLEAN_PUSH],
            reds: [{ ...LEFT_RED, findings: fourteen }],
        });
        const block = element.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;
        const rows = (): string[] => [...block.querySelectorAll(`[data-finding]`)].map((row) => wordsOf(row));

        // A card of its own in the Result lane, its name and what it stands at, then the push it came with.
        expect(block.closest(`[data-lane]`)?.getAttribute(`data-lane`)).toBe(`result`);
        expect(wordsOf(block.querySelector(`h3`))).toBe(`intentic`);
        expect(wordsOf(block.querySelector(`[data-meta]`))).toBe(`14 left at push`);
        expect(wordsOf(block.querySelector(`[data-push-line]`))).toBe(`725e054 · ${sinceWhen(PUSHED.at)} · main · 2 commits`);
        // Each row names the file or folder, not the five folders above it every row shares.
        expect(rows()).toEqual([
            `daemon-boundaries portability -> settings closes a cycle`,
            `layout workspace/explorer: 36 files, the baseline allows 33`,
            `layout workspace/files: 32 files`,
            `silent-catch workspace-trash.ts: 3 silent catch(es), the baseline allows 0`,
            `buttons SandboxMetricsDetails.vue:29  a bare <button>`,
            `paths workspace-trash.integration.test.ts:8  spells the state dir`,
            `silent-catch workspace-trash.ts:127  .catch discards the error`,
            `tidy-lines a1.ts:1  trailing space`,
        ]);

        const fold = [...block.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `+6 more`)!;
        fold.click();
        await nextTick();
        expect(rows()).toHaveLength(14);
        expect(rows().slice(-2)).toEqual([`tidy-lines a6.ts:1  trailing space`, `tidy-lines a7.ts:1  trailing space`]);
        expect(fold.textContent?.trim()).toBe(`Show fewer`);
    });

    it(`dismisses one finding or all of them, with an Undo that opens exactly those again`, async () => {
        const element = mount(pushedStatus());
        const block = element.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;

        block.querySelector<HTMLButtonElement>(`button[aria-label="Dismiss layout"]`)!.click();
        await nextTick();
        expect(dismissed).toHaveBeenCalledWith(`intentic`, [`layout-1`]);
        // Gone from the card the moment it is pressed, before the status comes back without it.
        expect(block.querySelectorAll(`[data-finding]`)).toHaveLength(6);
        await Promise.resolve();
        await nextTick();
        const receipt = useNotifications().receipt.value!;
        expect(receipt.title).toBe(`Dismissed 1 finding`);
        await receipt.actions![0]!.run();
        expect(dismissed).toHaveBeenLastCalledWith(`intentic`, [`layout-1`], true);

        const all = [...block.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `Dismiss all`)!;
        all.click();
        await nextTick();
        expect(dismissed).toHaveBeenLastCalledWith(`intentic`, [`daemon-1`, `layout-1`, `layout-2`, `silent-2`, `buttons-1`, `paths-1`, `silent-1`]);
    });

    it(`measures the project again on a press and says what the measurement found`, async () => {
        const element = mount(pushedStatus());
        element.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] button[aria-label="Measure again"]`)!.click();
        await nextTick();
        await Promise.resolve();
        expect(rechecked).toHaveBeenCalledWith(`intentic`);
        expect(useNotifications().receipt.value?.title).toBe(`Measured intentic again: 2 gone, 5 still open`);
    });

    it(`hands the findings to an agent only on a press, and opens the conversation it answers with`, async () => {
        const element = mount(pushedStatus());
        expect(handed).not.toHaveBeenCalled();

        element.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] [data-run]`)!.click();
        await nextTick();
        await Promise.resolve();
        expect(handed).toHaveBeenCalledWith(`intentic`, undefined, undefined);
        expect(opened).toHaveBeenCalledWith(`push-fix-intentic-0abc123`);
    });

    it(`opens the attempt already running when the daemon refuses a second one`, async () => {
        handed.mockRejectedValueOnce(new SandboxHttpError(409, `An agent is already on these findings.`));
        const element = mount(pushedStatus());
        element.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] [data-run]`)!.click();
        await nextTick();
        await Promise.resolve();
        await Promise.resolve();
        // Not in this roster yet, so it opens by the id every attempt 1 at these findings wears.
        expect(opened).toHaveBeenCalledWith(pushFixBase(LEFT_RED));
        expect(useNotifications().receipt.value).toBeUndefined();
    });

    it(`shows the agent already on them in place of a second press, with the way to its conversation`, async () => {
        attemptOnIt.value = {
            agent: {
                id: `push-fix-intentic-0abc123`,
                title: `Fix what the push left in intentic`,
                status: `running`,
                provider: `claude`,
                harness: `native`,
                updatedAt: NOW,
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            },
            attempt: 1,
            stance: { kind: `working`, ongoing: true, retry: false, label: `Agent working`, hint: `An agent is already working on this failure.` },
        };
        const element = mount(pushedStatus());
        const block = element.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;

        expect(block.querySelector(`[data-run]`)).toBeNull();
        expect(wordsOf(block.querySelector(`[data-attempt]`))).toBe(`Agent working Fix what the push left in intentic`);
        block.querySelector<HTMLButtonElement>(`[data-attempt] button`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`push-fix-intentic-0abc123`);
    });
});

// A SANDBOX FROM BEFORE 2026-09-25: it serves the runs but no reds, no check terminals and no split failures. Nothing is
// rebuilt from its runs; the view says it needs an update, and a current sandbox's says nothing of the kind.
describe(`the main line of an older sandbox, in the view`, () => {
    // What v1.312 served for the same moment as redStatus: the raw runs, and pushes with nothing saying what is owed.
    const olderStatus = (): MainlineStatus => ({
        projects: [{ project: `web`, queued: [], last: { ...RED, units: undefined, named: undefined }, redSince: RED.at }],
        recent: [{ ...RED, units: undefined, named: undefined }, green({ at: NOW - 90 * MINUTE })],
        pushed: [PUSHED],
    });

    it(`opens onto the note and the runs as served: no cause, no fixer, no logs, no failure list, no pushes`, async () => {
        const element = mount(olderStatus());
        const note = element.querySelector<HTMLElement>(`[data-outdated]`)!;
        expect(wordsOf(note)).toBe(
            `This sandbox runs an older version Until it updates, this panel can't say who a failing check is laid at or who is fixing it, open a check's logs, or show what your pushes left behind. Update the sandbox Installed it yourself? Reinstall it, or run this on the machine that runs it: ic sandbox update`,
        );
        expect(note.querySelector(`a[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
        // Where health would be, the header says it needs an update: a pass for want of a red would be a guess.
        expect(wordsOf(summaryOf(element))).toBe(`Sandbox needs an update`);
        expect(summaryOf(element).textContent).not.toContain(`left at push`);
        expect(wordsOf(lane(element, `result`).querySelector(`[data-result="web"]`))).toBe(`web failing · Release notes 30m ago`);
        expect(element.querySelector(`[data-cause], [data-fix], [data-failures], [data-section="push-web"], [data-section="push-intentic"]`)).toBeNull();
        expect([...element.querySelectorAll(`button`)].some((button) => wordsOf(button) === `Logs`)).toBe(false);

        lane(element, `result`).querySelector<HTMLButtonElement>(`[data-history]`)!.click();
        await nextTick();
        expect(element.querySelector(`[data-event="push"]`)).toBeNull();
    });

    it(`draws no note for a current sandbox`, () => {
        const element = mount(redStatus());
        expect(element.querySelector(`[data-outdated]`)).toBeNull();
        expect(wordsOf(summaryOf(element))).not.toContain(`needs an update`);
    });
});
