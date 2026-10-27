// The group's one load-bearing claim: this switch is somebody agreeing to run a command written in a file they may not
// have read, so the row has to show the command itself, and a declaration that changed since they agreed has to read as
// held rather than as running.
import "@intentic/testing/dom";
import type { RepoChecksSummary } from "@intentic/sandbox-contract/schemas/settings";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { timeAgo } from "@intentic/ui";

const repos = ref<RepoChecksSummary[] | undefined>([]);
const adopt = jest.fn();

jest.mock(`../../../../models/sandbox/environment/useRepoChecks`, () => ({
    useRepoChecks: () => ({
        repos,
        adopt,
        pending: ref(undefined),
        error: ref(undefined),
        loaded: computed(() => ({ state: `ready`, data: repos.value ?? [], refreshing: false, refreshError: undefined })),
        busy: ref(false),
    }),
}));

const { default: AgentRepoChecks } = await import("./AgentRepoChecks.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentRepoChecks) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    repos.value = [];
    adopt.mockClear();
});

const declaring = (over: Partial<RepoChecksSummary> = {}): RepoChecksSummary => ({
    repo: `intentic`,
    path: `intentic/.intentic/checks.json`,
    checks: [{ when: `edit`, run: `pnpm exec eslint {file}` }],
    fired: [null],
    adopted: true,
    changed: false,
    ...over,
});

const switchOf = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(`[aria-label^="Run the checks"]`);

test(`a repository's row prints the command it declares, not a count of them`, () => {
    repos.value = [declaring()];
    const host = mount();
    expect(host.textContent).toContain(`pnpm exec eslint {file}`);
    expect(host.textContent).toContain(`intentic/.intentic/checks.json`);
});

// A check is drawn on the row's own surface, not in a box of its own: the command, then one quiet line with its scope and
// its verdict, under the label of the moment it runs at.
test(`a check reads as its command, then its scope and verdict on one quiet line, with no surface of its own`, () => {
    repos.value = [declaring({ checks: [{ when: `edit`, run: `pnpm exec eslint {file}`, paths: [`src/**`, `test/**`] }] })];
    const host = mount();
    const line = host.querySelector(`li`)!;
    expect(line.closest(`[class*="rounded"][class*="border"]`)).toBeNull();
    expect(line.children[0]!.textContent).toBe(`pnpm exec eslint {file}`);
    expect([...line.children[1]!.children].map((part) => part.textContent?.trim())).toEqual([
        `only when touching src/**, test/**`,
        `·`,
        `never flagged`,
    ]);
    expect(host.textContent).toContain(`After each edit`);
    expect(adopt).not.toHaveBeenCalled();
});

// Checks sit under the moment they run at, each moment named once however many checks it has.
const groupsOf = (host: HTMLElement): string[][] =>
    [...host.querySelectorAll(`ul`)].map((list) => [
        list.previousElementSibling?.textContent ?? ``,
        ...[...list.querySelectorAll(`li`)].map((line) => line.textContent ?? ``),
    ]);

test(`each check is named by the moment it runs at, once per moment`, () => {
    repos.value = [
        declaring({
            checks: [
                { when: `land`, run: `pnpm test` },
                { when: `edit`, run: `pnpm exec eslint {file}` },
                { when: `turn`, run: `pnpm lint` },
                { when: `edit`, run: `pnpm exec prettier --check {file}` },
            ],
            fired: [null, null, null, null],
        }),
    ];
    const groups = groupsOf(mount());
    expect(groups.map(([label]) => label)).toEqual([
        `After each edit`,
        `When a turn ends — said back to the agent once, never blocks`,
        `After it lands — no longer runs; CI checks what is pushed`,
    ]);
    expect(groups[0]!.slice(1).map((line) => line.split(`never`)[0])).toEqual([`pnpm exec eslint {file}`, `pnpm exec prettier --check {file}`]);
    expect(groups[2]!.slice(1)).toEqual([`pnpm test`]);
});

// A turn check runs once as an isolated turn ends and says what it found back to the agent; nothing runs after work
// lands any more, so a declaration still naming that moment reads, says it runs nothing, and looks as inert as a check
// nobody switched on.
test(`a turn check runs and says when it last flagged something, and a declared land check says it no longer runs`, () => {
    repos.value = [
        declaring({
            checks: [
                { when: `turn`, run: `pnpm lint` },
                { when: `land`, run: `pnpm verify` },
            ],
            fired: [FIVE_DAYS_AGO, FIVE_DAYS_AGO],
        }),
    ];
    const host = mount();
    const [turn, land] = [...host.querySelectorAll<HTMLElement>(`li`)];
    expect([turn?.textContent, land?.textContent]).toEqual([`pnpm lintlast flagged ${timeAgo(FIVE_DAYS_AGO, { days: true })}`, `pnpm verify`]);
    expect([turn?.classList.contains(`opacity-60`), land?.classList.contains(`opacity-60`)]).toEqual([false, true]);
    const labels = [...host.querySelectorAll(`ul`)].map((list) => list.previousElementSibling);
    expect(labels.map((label) => label?.classList.contains(`opacity-60`))).toEqual([false, true]);
});

const FIVE_DAYS_AGO = Date.now() - 5 * 86_400_000;

// A check that never flagged anything is either healthy or aimed at nothing; either way the row says which is the case.
test(`a running edit check says when it last flagged something, and a retired land check claims nothing`, () => {
    repos.value = [
        declaring({
            checks: [
                { when: `edit`, run: `pnpm exec eslint {file}` },
                { when: `edit`, run: `pnpm exec prettier --check {file}` },
                { when: `land`, run: `pnpm test` },
            ],
            fired: [FIVE_DAYS_AGO, null, null],
        }),
    ];
    const lines = [...mount().querySelectorAll(`li`)].map((line) => line.textContent ?? ``);
    expect(lines.find((line) => line.includes(`eslint`))).toContain(`last flagged ${timeAgo(FIVE_DAYS_AGO, { days: true })}`);
    expect(lines.find((line) => line.includes(`prettier`))).toContain(`never flagged`);
    expect(lines.find((line) => line.includes(`pnpm test`))).not.toContain(`flagged`);
});

test(`a check nobody switched on claims no history`, () => {
    repos.value = [declaring({ adopted: false })];
    expect(mount().textContent).not.toContain(`flagged`);
});

test(`switching a row on adopts that repository, by name`, async () => {
    repos.value = [declaring({ adopted: false })];
    const host = mount();
    switchOf(host)!.click();
    await nextTick();
    expect(adopt).toHaveBeenCalledWith(`intentic`, true);
});

test(`a declaration that changed since it was adopted says it is not running`, () => {
    repos.value = [declaring({ adopted: false, changed: true })];
    const host = mount();
    expect(host.textContent).toContain(`changed since you switched it on`);
});

// A check added to an agreed file waits on its own; the checks the owner already read keep running and say so.
test(`a declaration that gained a check runs what was agreed to, and marks only the new one as waiting`, () => {
    repos.value = [
        declaring({
            adopted: false,
            changed: true,
            checks: [
                { when: `edit`, run: `pnpm exec eslint {file}` },
                { when: `turn`, run: `node warm.mjs` },
            ],
            fired: [FIVE_DAYS_AGO, null],
            held: [false, true],
        }),
    ];
    const host = mount();
    expect(host.textContent).toContain(`Partly paused: 1 check is new or changed`);
    const lines = [...host.querySelectorAll(`li`)];
    const eslint = lines.find((line) => line.textContent?.includes(`eslint`));
    const warm = lines.find((line) => line.textContent?.includes(`warm.mjs`));
    expect(eslint?.textContent).toContain(`last flagged`);
    expect(eslint?.className).not.toContain(`opacity-60`);
    expect(warm?.textContent).toContain(`new or changed, waits for you`);
    expect(warm?.className).toContain(`opacity-60`);
});

// An older sandbox says only `changed`: the whole file reads as paused, as it is there.
test(`a changed declaration that says nothing of which checks wait reads as wholly paused`, () => {
    repos.value = [declaring({ adopted: false, changed: true, fired: [FIVE_DAYS_AGO] })];
    const host = mount();
    expect(host.textContent).toContain(`Paused: this changed since you switched it on`);
    expect(host.textContent).not.toContain(`last flagged`);
    expect(host.textContent).toContain(`new or changed, waits for you`);
});

// Said on the row that waits, and only there: a count at the group's foot would repeat it.
test(`a declaration nobody has answered yet says so on its own row`, () => {
    repos.value = [declaring({ adopted: false })];
    const host = mount();
    expect(host.textContent).toContain(`Off. Nothing a repository declares runs`);
    expect(host.textContent).not.toContain(`waiting on you`);
});

// The empty state carries the whole feature for a workspace that has never used it, so it has to name the file.
test(`a workspace where nothing declares anything names the file that would, and that nothing it declares holds work`, () => {
    repos.value = [];
    const host = mount();
    expect(host.textContent).toContain(`.intentic/checks.json`);
    expect(host.textContent).toContain(`what runs on its own code after each edit`);
    expect(host.textContent).toContain(`ever blocks a land, a commit or a push`);
});
