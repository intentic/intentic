// The group's one load-bearing claim: this switch is somebody agreeing to run a command written in a file they may not
// have read, so the row has to show the command itself, and a declaration that changed since they agreed has to read as
// held rather than as running.
import "@intentic/testing/dom";
import type { RepoChecksSummary } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { test, expect, afterEach, mock } from "bun:test";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { timeAgo } from "@intentic/ui";

const repos = ref<RepoChecksSummary[] | undefined>([]);
const adopt = mock();

mock.module(`../../environment/useRepoChecks`, () => ({
    useRepoChecks: () => ({ repos, adopt, pending: ref(undefined), error: ref(undefined), isLoading: ref(false), busy: ref(false) }),
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
    checks: [{ when: `turn`, run: `pnpm verify` }],
    fired: [null],
    adopted: true,
    changed: false,
    ...over,
});

const switchOf = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(`[aria-label^="Run the checks"]`);

test(`a repository's row prints the command it declares, not a count of them`, () => {
    repos.value = [declaring()];
    const host = mount();
    expect(host.textContent).toContain(`pnpm verify`);
    expect(host.textContent).toContain(`intentic/.intentic/checks.json`);
});

test(`each check is named by the moment it runs at`, () => {
    repos.value = [
        declaring({
            checks: [
                { when: `edit`, run: `pnpm exec eslint {file}` },
                { when: `turn`, run: `pnpm lint` },
                { when: `land`, run: `pnpm test` },
            ],
            fired: [null, null, null],
        }),
    ];
    const lines = [...mount().querySelectorAll(`span.flex-col > span`)].map((line) => line.textContent ?? ``);
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.includes(`eslint`))).toContain(`after each edit`);
    expect(lines.find((line) => line.includes(`pnpm lint`))).toContain(`before a turn ends`);
    expect(lines.find((line) => line.includes(`pnpm test`))).toContain(`after it lands`);
});

// The package script runs after a land whatever the owner adopted, so the row states it, undimmed, with nothing to switch.
test(`a repository that declares nothing shows the package script that runs after a land, with no switch`, () => {
    repos.value = [declaring({ checks: [], fired: [], adopted: false, landDefault: `pnpm test` })];
    const host = mount();
    expect(host.textContent).toContain(`after it lands`);
    expect(host.textContent).toContain(`pnpm test`);
    expect(host.textContent).toContain(`(package script)`);
    expect(switchOf(host)).toBeNull();
    expect(host.querySelector(`.opacity-60`)).toBeNull();
    expect(host.textContent).not.toContain(`waiting on you`);
});

test(`a declared land check replaces the package script`, () => {
    repos.value = [declaring({ checks: [{ when: `land`, run: `pnpm test:integration` }], fired: [null], landDefault: `pnpm test` })];
    const host = mount();
    expect(host.textContent).toContain(`pnpm test:integration`);
    expect(host.textContent).not.toContain(`(package script)`);
});

const FIVE_DAYS_AGO = Date.now() - 5 * 86_400_000;

// A check that never flagged anything is either healthy or aimed at nothing; either way the row says which is the case.
test(`a running check says when it last flagged something, and a land check leaves that to the activity feed`, () => {
    repos.value = [
        declaring({
            checks: [
                { when: `edit`, run: `pnpm exec eslint {file}` },
                { when: `turn`, run: `pnpm lint` },
                { when: `land`, run: `pnpm test` },
            ],
            fired: [FIVE_DAYS_AGO, null, null],
        }),
    ];
    const lines = [...mount().querySelectorAll(`span.flex-col > span`)].map((line) => line.textContent ?? ``);
    expect(lines.find((line) => line.includes(`eslint`))).toContain(`last flagged ${timeAgo(FIVE_DAYS_AGO, { days: true })}`);
    expect(lines.find((line) => line.includes(`pnpm lint`))).toContain(`never flagged`);
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

test(`a declaration nobody has answered yet says so, and counts itself at the foot`, () => {
    repos.value = [declaring({ adopted: false })];
    const host = mount();
    expect(host.textContent).toContain(`Declared, not running`);
    expect(host.textContent).toContain(`One repository is waiting on you`);
});

// The empty state carries the whole feature for a workspace that has never used it, so it has to name the file.
test(`a workspace where nothing declares anything names the file that would`, () => {
    repos.value = [];
    const host = mount();
    expect(host.textContent).toContain(`.intentic/checks.json`);
});
