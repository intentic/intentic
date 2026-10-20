import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { useTheme } from "@intentic/ui/theme";
import type { DaemonSession } from "@intentic/sandbox-contract/schemas/system";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { IntenticNative, NativeMessage } from "../app/environments/nativeApp";
import { THEME_ROW } from "../features/settings/themeRow";
import { useSkin } from "../skins/useSkin";

// The router inside the Android app's WebView, against a real router in the shell's shape. The page is the app's from
// the first read of the flag on, so the tab says so before the module is loaded; every case stands up its own router.
sessionStorage.setItem(`intentic.embed`, `native`);
const { NATIVE_LOOKS } = await import(`../app/environments/nativeApp`);
const { hasStepBack, installNativeApp, nativeScreen, withoutEmbedQuery } = await import(`./nativeHandoff`);

const page = { render: () => null };

/** The app's object, recording what the page told it, as the methods addJavascriptInterface injects. */
const appHearing = () => {
    const told: NativeMessage[] = [];
    const native: IntenticNative = {
        open: (path) => void told.push({ kind: `open`, path }),
        signOut: () => void told.push({ kind: `signOut` }),
        routed: (path, title, canGoBack) => void told.push({ kind: `routed`, path, title, canGoBack }),
    };
    window.intenticNative = native;
    return { opened: () => told.flatMap((message) => (message.kind === `open` ? [message.path] : [])), told };
};

/** The tab's history as the page reads it: where it stands, and the step back a sheet or a page listens for. */
const tabHistory = (start: number) => {
    let at = start;
    return { position: (): number => at, stepBack: (): void => void (at -= 1), forward: (): void => void (at += 1), at: (): number => at };
};

const stage = (start = 3) => {
    const history = tabHistory(start);
    const adopted: [string, DaemonSession][] = [];
    const router: Router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/login`, component: page },
            {
                path: `/`,
                component: page,
                children: [
                    { path: ``, redirect: `/agents` },
                    { path: `agents`, component: page },
                    { path: `agents/:id`, component: page },
                    { path: `agents/:id/pages/:page`, component: page },
                    { path: `chat`, component: page },
                    { path: `menu`, component: page },
                    { path: `sandbox/:tab?`, component: page, meta: { title: () => `Sandbox` } },
                    { path: `settings/:tab?`, component: page, meta: { title: () => `Settings` } },
                ],
            },
        ],
    });
    installNativeApp(router, {
        show: async (path) => {
            await router.push(path);
            history.forward();
        },
        activeConversation: async () => `cnv_open`,
        adoptSession: (sandboxId, session) => void adopted.push([sandboxId, session]),
        position: history.position,
        stepBack: history.stepBack,
    });
    const embed = window.intenticEmbed;
    if (embed === undefined) {
        throw new Error(`installNativeApp set no window.intenticEmbed`);
    }
    return { router, history, adopted, embed };
};

beforeEach(() => {
    useTheme().set(`system`);
    useSkin().setSkin(`system`);
    localStorage.clear();
    sessionStorage.removeItem(`intentic.embed.look`);
    delete window.intenticNative;
    delete window.intenticEmbed;
    useTheme().hand(undefined);
    useSkin().hand(undefined);
});

describe(`the screens the app draws itself`, () => {
    const at = (fullPath: string) => {
        const url = new URL(fullPath, `https://app.intentic.dev`);
        return { path: url.pathname, query: Object.fromEntries(url.searchParams), fullPath };
    };

    it(`are the board, a conversation, the menu and the sign-in pages, whole`, () => {
        expect(nativeScreen(at(`/agents`))).toBe(`/agents`);
        expect(nativeScreen(at(`/agents?sandbox=sbx_2`))).toBe(`/agents?sandbox=sbx_2`);
        expect(nativeScreen(at(`/agents/cnv_1`))).toBe(`/agents/cnv_1`);
        expect(nativeScreen(at(`/menu`))).toBe(`/menu`);
        expect(nativeScreen(at(`/login?returnTo=%2Fsettings`))).toBe(`/login?returnTo=%2Fsettings`);
        expect(nativeScreen(at(`/login/confirm`))).toBe(`/login/confirm`);
    });

    it(`name a conversation as its own screen however the route named it`, () => {
        expect(nativeScreen(at(`/?conversation=cnv_1`))).toBe(`/agents/cnv_1`);
        expect(nativeScreen(at(`/settings?conversation=a/b`))).toBe(`/agents/a%2Fb`);
        expect(nativeScreen(at(`/agents?focus=cnv_2`))).toBe(`/agents/cnv_2`);
        expect(nativeScreen(at(`/chat?focus=cnv_3`))).toBe(`/agents/cnv_3`);
    });

    // The two addresses under an agent the app shows in its WebView rather than drawing: its Changes alone, and one
    // page it showed, full screen.
    it(`leave an agent's Changes and its full-screen pages to the page, and nothing else under it`, () => {
        expect(nativeScreen(at(`/agents/cnv_1?view=changes`))).toBeUndefined();
        expect(nativeScreen(at(`/agents/cnv_1/pages/a1b2c3d4e5`))).toBeUndefined();
        expect(nativeScreen(at(`/agents/cnv_1?view=chat`))).toBe(`/agents/cnv_1?view=chat`);
        expect(nativeScreen(at(`/agents?view=changes`))).toBe(`/agents?view=changes`);
    });

    it(`leave the chat alone to the guard, which reads the conversation it has open`, () => {
        expect(nativeScreen(at(`/chat`))).toBe(`/chat`);
    });

    it(`leave every other screen to the page`, () => {
        for (const path of [`/settings`, `/sandbox/models`, `/workspace/src/a.ts`, `/capabilities`, `/devices`, `/browsers`, `/ext/approvals`, `/terminal`, `/setup`]) {
            expect(nativeScreen(at(path))).toBeUndefined();
        }
        expect(nativeScreen(at(`/agentsmith`))).toBeUndefined();
        expect(nativeScreen(at(`/loginx`))).toBeUndefined();
    });

    // The Theme row's looks are what the app may hand over; a fifth on either side would be a look one cannot wear.
    it(`take exactly the Theme row's looks`, () => {
        expect([...NATIVE_LOOKS]).toEqual([...THEME_ROW]);
    });
});

describe(`the app's address keys`, () => {
    it(`come off the route, every other key and the hash kept`, () => {
        expect(withoutEmbedQuery({ path: `/settings`, query: { embed: `native`, look: `dark`, tab: `x` }, hash: `#voice` })).toEqual({
            path: `/settings`,
            query: { tab: `x` },
            hash: `#voice`,
            replace: true,
        });
        expect(withoutEmbedQuery({ path: `/settings`, query: { tab: `x` }, hash: `` })).toBeUndefined();
    });

    it(`are gone from the address the first navigation lands on`, async () => {
        const { router } = stage();
        appHearing();
        await router.push(`/settings/account?embed=native&look=dark&found=claude`);
        expect(router.currentRoute.value.fullPath).toBe(`/settings/account?found=claude`);
    });
});

describe(`a navigation to one of the app's screens`, () => {
    it(`is handed to the app and goes nowhere here`, async () => {
        const { router } = stage();
        const app = appHearing();
        await router.push(`/settings`);

        await router.push(`/agents/cnv_1`);
        await router.push(`/menu`);
        await router.push(`/login?returnTo=/settings`);

        expect(app.opened()).toEqual([`/agents/cnv_1`, `/menu`, `/login?returnTo=/settings`]);
        expect(router.currentRoute.value.fullPath).toBe(`/settings`);
    });

    // The home redirect's own target, the board, is what the app is told: the guard reads where a navigation lands.
    it(`is caught after a redirect, as the place it was redirected to`, async () => {
        const { router } = stage();
        const app = appHearing();
        await router.push(`/sandbox`);
        await router.push(`/`);
        expect(app.opened()).toEqual([`/agents`]);
    });

    it(`to the chat opens the conversation the chat has open`, async () => {
        const { router } = stage();
        const app = appHearing();
        await router.push(`/settings`);
        await router.push(`/chat`);
        expect(app.opened()).toEqual([`/agents/cnv_open`]);
    });

    it(`stays in the page for an agent's Changes and a page it showed, which the app opens here`, async () => {
        const { router, embed } = stage();
        const app = appHearing();
        await router.push(`/agents/cnv_1?view=changes`);
        expect(router.currentRoute.value.fullPath).toBe(`/agents/cnv_1?view=changes`);
        expect(embed.open(`/agents/cnv_1/pages/a1b2c3d4e5`)).toBe(true);
        await waitFor(() => expect(router.currentRoute.value.fullPath).toBe(`/agents/cnv_1/pages/a1b2c3d4e5`));
        expect(app.opened()).toEqual([]);
    });

    it(`goes ahead in the page where the app hears no such message`, async () => {
        const { router } = stage();
        window.intenticNative = {};
        await router.push(`/agents/cnv_1`);
        expect(router.currentRoute.value.fullPath).toBe(`/agents/cnv_1`);
    });

    it(`lets every other screen land, and tells the app where the page now is`, async () => {
        const { router, history } = stage();
        const app = appHearing();
        await router.push(`/settings`);
        history.forward();
        await router.push(`/sandbox/models`);
        expect(router.currentRoute.value.fullPath).toBe(`/sandbox/models`);
        expect(app.told).toEqual([
            { kind: `routed`, path: `/settings`, title: `Settings`, canGoBack: false },
            { kind: `routed`, path: `/sandbox/models`, title: `Sandbox`, canGoBack: true },
        ]);
    });
});

describe(`the app asking for a step back`, () => {
    it(`steps back through the page's own history and says it did`, () => {
        const { embed, history } = stage(3);
        history.forward();
        history.forward();
        expect(embed.back()).toBe(true);
        expect(history.at()).toBe(4);
        expect(embed.back()).toBe(true);
        expect(history.at()).toBe(3);
    });

    // Below the entry the app opened the page on lies what the app showed before: never the page's to step into.
    it(`says there was none on the entry the app opened, so the app closes the page`, () => {
        const { embed, history } = stage(3);
        expect(embed.back()).toBe(false);
        expect(history.at()).toBe(3);
    });

    it(`counts from where the app last opened a route in the page`, async () => {
        const { router, embed, history } = stage(3);
        await router.push(`/settings`);
        expect(embed.open(`/sandbox/access`)).toBe(true);
        // The open lands one entry up, and the page counts from there: no step back below it.
        await waitFor(() => expect(history.at()).toBe(4));
        expect(router.currentRoute.value.fullPath).toBe(`/sandbox/access`);
        expect(embed.back()).toBe(false);
        expect(history.at()).toBe(4);
    });

    it(`is the plain rule: an entry above the one opened on`, () => {
        expect(hasStepBack(5, 4)).toBe(true);
        expect(hasStepBack(4, 4)).toBe(false);
        expect(hasStepBack(3, 4)).toBe(false);
        expect(hasStepBack(undefined, 4)).toBe(false);
        expect(hasStepBack(5, undefined)).toBe(false);
    });
});

describe(`the app opening a route in the page`, () => {
    it(`refuses its own screens and anything that is not a path on this origin`, () => {
        const { embed } = stage();
        appHearing();
        for (const path of [`/agents`, `/agents/cnv_1`, `/menu`, `/login`, `//evil.example/x`, `https://evil.example/`, ``]) {
            expect(embed.open(path)).toBe(false);
        }
    });
});

describe(`the look the app hands over`, () => {
    it(`is worn as both halves of the Theme row's look, and stored nowhere but the tab`, () => {
        const { embed } = stage();
        expect(embed.setLook(`sanctum`)).toBe(true);
        expect(useTheme().scheme.value).toBe(`dark`);
        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(localStorage.getItem(`ui-color-scheme`)).toBeNull();
        expect(localStorage.getItem(`ui-skin`)).toBeNull();
        expect(sessionStorage.getItem(`intentic.embed.look`)).toBe(`sanctum`);

        expect(embed.setLook(`light`)).toBe(true);
        expect(useTheme().scheme.value).toBe(`light`);
        expect(useSkin().skin.value).toBe(`none`);
    });

    it(`outranks the reader's own choice without changing it`, () => {
        useTheme().set(`light`);
        const { embed } = stage();
        embed.setLook(`dark`);
        expect(useTheme().scheme.value).toBe(`dark`);
        expect(useSkin().skin.value).toBe(`none`);
        expect(useTheme().choice.value).toBe(`light`);
    });

    it(`is the one the address named, worn from the moment the router is installed`, () => {
        sessionStorage.setItem(`intentic.embed.look`, `dark`);
        stage();
        expect(useTheme().handed.value).toBe(`dark`);
        expect(useSkin().handed.value).toBe(`none`);
    });

    it(`is refused when it is not one of the four`, () => {
        const { embed } = stage();
        expect(embed.setLook(`blue`)).toBe(false);
        expect(useTheme().handed.value).toBeUndefined();
    });
});

describe(`a daemon session the app hands over`, () => {
    const session = { token: `jwt.from.the.app`, expiresAt: Date.now() + 86_400_000, email: `ada@example.com` };

    it(`is kept for the sandbox it names`, () => {
        const { embed, adopted } = stage();
        expect(embed.adoptSession(`sbx_1`, session)).toBe(true);
        expect(adopted).toEqual([[`sbx_1`, session]]);
    });

    it(`is refused when it is spent, malformed or names no sandbox`, () => {
        const { embed, adopted } = stage();
        expect(embed.adoptSession(`sbx_1`, { ...session, expiresAt: Date.now() - 1 })).toBe(false);
        // SAFETY: deliberately not a session, as Kotlin could hand over.
        expect(embed.adoptSession(`sbx_1`, { token: `t` } as DaemonSession)).toBe(false);
        expect(embed.adoptSession(``, session)).toBe(false);
        expect(adopted).toEqual([]);
    });
});
