// @vitest-environment jsdom
// The group's one load-bearing claim: this switch is somebody agreeing to run a command written in a file they may not
// have read, so the row has to show the command itself, and a declaration that changed since they agreed has to read as
// held rather than as running.
import type { RepoChecksSummary } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const repos = ref<RepoChecksSummary[] | undefined>([]);
const adopt = vi.fn();

vi.mock(`../../environment/useRepoChecks`, () => ({
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
    checks: [{ when: `push`, run: `pnpm verify:push` }],
    adopted: true,
    changed: false,
    ...over,
});

const switchOf = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>(`[aria-label^="Run the checks"]`)!;

test(`a repository's row prints the command it declares, not a count of them`, () => {
    repos.value = [declaring()];
    const host = mount();
    expect(host.textContent).toContain(`pnpm verify:push`);
    expect(host.textContent).toContain(`intentic/.intentic/checks.json`);
});

test(`switching a row on adopts that repository, by name`, async () => {
    repos.value = [declaring({ adopted: false })];
    const host = mount();
    switchOf(host).click();
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
