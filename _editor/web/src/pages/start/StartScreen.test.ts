// @vitest-environment jsdom
//
// THE SCREEN SETUP HANDS THE USER TO, MOUNTED. Its whole job is to give something before it asks for anything,
// and the three states it can be in are decided by facts rather than by a step counter — so the way it breaks
// is by reading one of those facts wrong and showing the confident wrong screen. Each state is asserted here
// against the real component, along with the two ways it must get out of the user's way: a workspace that
// already has repositories, and the skip link.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../composables/chat/providerAccounts";
import { endpointProviders, trialStatus } from "../../composables/chat/providerCatalog";
import { PANELS, PUBLIC } from "../../composables/queryKeys";
import { queryClient } from "../../composables/queryPersistence";
import { router } from "../../router";
import StartScreen from "./StartScreen.vue";
import { firstRunDone } from "./firstRun";

// The same import-time globals the other mounted-component tests stand up (see firstRunBoard.test.ts).
// matches:false keeps the device DESKTOP, where this screen keeps the user beside the docked chat.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    queryClient.clear();
    localStorage.clear();
});

// The connection picture is stated outright by every test rather than inherited. Read: the daemon has
// answered, and a Claude subscription is connected — which is the state in which this screen asks its question.
beforeEach(async () => {
    accountsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never, grok: [] };
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    await router.replace(`/start`);
});

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(StartScreen) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    mounted.push(app);
    return el;
};

// The two daemon reads this screen turns on, seeded as settled query data so no request is made.
const withRepos = (...repos: string[]): void => {
    queryClient.setQueryData(PANELS.of(), { panels: repos.map((repo) => ({ repo })) });
};
const withOutbox = (files: unknown[], url = `https://public.test`): void => {
    queryClient.setQueryData(PUBLIC.of(), { url, files });
};
const page = (path: string, blocked?: string): unknown => ({
    path,
    size: 10,
    modifiedAt: 0,
    ...(blocked === undefined ? { url: `https://public.test/${path}` } : { blocked }),
});

const buttonNamed = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

it(`asks what to build, and offers examples that fill the box rather than sending`, async () => {
    withRepos();
    const screen = mount();
    await nextTick();

    expect(screen.textContent).toContain(`What should I build?`);
    const box = screen.querySelector(`textarea`)!;
    expect(box.value).toBe(``);
    // Nothing typed is nothing to send.
    expect(screen.querySelector<HTMLButtonElement>(`button[type="submit"]`)!.disabled).toBe(true);

    buttonNamed(screen, `A page for my business`)!.click();
    await nextTick();

    expect(box.value).toContain(`coffee roastery`);
    expect(screen.querySelector<HTMLButtonElement>(`button[type="submit"]`)!.disabled).toBe(false);
});

/* NOTHING CAN SEND YET is the state a genuinely fresh sandbox is in, and the screen must not ask a question
 * whose answer it could not act on — it makes the way in instead, the same card every other gate shows. */
it(`makes the connect offer when nothing can send, and asks nothing else`, async () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
    withRepos();
    const screen = mount();
    await nextTick();

    expect(screen.textContent).toContain(`Try free with Google`);
    expect(screen.textContent).not.toContain(`What should I build?`);
    expect(screen.querySelector(`textarea`)).toBeNull();
});

it(`waits for the daemon before claiming nothing is connected`, async () => {
    accountsLoaded.value = false;
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
    withRepos();
    const screen = mount();
    await nextTick();

    expect(screen.textContent).toContain(`Checking your AI accounts…`);
    expect(screen.textContent).not.toContain(`Try free with Google`);
});

/* THE PAYOFF. Read off the OUTBOX rather than off a local "did I press build" flag, which is what makes a
 * reload mid-build land back on the result instead of back on the question — so a seeded outbox alone, with
 * nothing pressed in this mount, is enough to put the screen in its third state. */
it(`shows the built page at its public link, and says plainly that the link is public`, async () => {
    withRepos();
    withOutbox([page(`index.html`)]);
    const screen = mount();
    await nextTick();

    expect(screen.textContent).toContain(`Your page is live`);
    expect(screen.querySelector(`iframe`)?.getAttribute(`src`)).toBe(`https://public.test/index.html`);
    // The sandbox attribute is the reason an arbitrary generated page may be framed here at all.
    expect(screen.querySelector(`iframe`)?.getAttribute(`sandbox`)).toBe(`allow-scripts`);
    expect(screen.textContent).toContain(`Anyone with this link can open it`);
});

it(`prefers the index the task asked for over another page beside it`, async () => {
    withRepos();
    withOutbox([page(`extra.html`), page(`index.html`)]);
    const screen = mount();
    await nextTick();

    expect(screen.querySelector(`iframe`)?.getAttribute(`src`)).toBe(`https://public.test/index.html`);
});

/* A page in the outbox that a guard refuses looks exactly like nothing having happened, and the publisher is
 * the only person who can ever be told why — a stranger requesting it gets the same 404 every miss gets. */
it(`says why a built page is not being served`, async () => {
    withRepos();
    withOutbox([page(`index.html`, `blocked-name`)]);
    const screen = mount();
    await nextTick();

    expect(screen.textContent).toContain(`isn't being served`);
    expect(screen.textContent).toContain(`blocked-name`);
    expect(screen.querySelector(`iframe`)).toBeNull();
});

// A box with no tunnel has nowhere to publish to, and a screen promising a public link on one would be lying.
it(`does not promise a link on a sandbox that cannot publish`, async () => {
    withRepos();
    queryClient.setQueryData(PUBLIC.of(), { files: [] });
    const screen = mount();
    await nextTick();
    buttonNamed(screen, `A personal profile`)!.click();
    await nextTick();

    expect(screen.textContent).not.toContain(`Anyone with this link can open it`);
});

/* THE TWO WAYS OUT, and they matter more than any state above: somebody who came here with work must never
 * have to get past a demo to reach it.
 *
 * The DESTINATION is what is asserted, not the resulting route: /workspace is behind the session and sandbox
 * guards, which in a unit mount have neither and divert to the platform-unavailable screen. Spying on the
 * navigation reads this screen's decision, which is the part that belongs to this file. */
it(`stands down on its own when the workspace already has repositories`, async () => {
    const replace = vi.spyOn(router, `replace`).mockResolvedValue(undefined);
    withRepos(`app`);
    mount();
    await nextTick();

    expect(replace).toHaveBeenCalledWith(`/workspace`);
    // And does not ask again, on this sandbox or the next one.
    expect(firstRunDone()).toBe(true);
});

/* PRESSING BUILD IS ITSELF THE ANSWER. Recorded then rather than when the user finally leaves, because
 * somebody who wanders off through the rail would otherwise be sent back here by the shell's entry on every
 * session afterwards — the demo becoming the thing it was built to stop being. */
it(`counts building as answering the screen`, async () => {
    withRepos();
    const screen = mount();
    await nextTick();

    buttonNamed(screen, `Something playful`)!.click();
    await nextTick();
    screen.querySelector<HTMLButtonElement>(`button[type="submit"]`)!.click();
    await nextTick();

    expect(firstRunDone()).toBe(true);
    // And the press moves the screen to its third state rather than leaving the question up behind the turn.
    expect(screen.textContent).toContain(`Building your page…`);
});

it(`leaves for the workspace on one press, and remembers that it was answered`, async () => {
    const replace = vi.spyOn(router, `replace`).mockResolvedValue(undefined);
    withRepos();
    const screen = mount();
    await nextTick();

    expect(firstRunDone()).toBe(false);
    buttonNamed(screen, `Skip — I have my own code`)!.click();
    await nextTick();

    expect(replace).toHaveBeenCalledWith(`/workspace`);
    expect(firstRunDone()).toBe(true);
});
