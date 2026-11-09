import {
    ACCOUNT_PAGES,
    HOME_SEGMENT,
    homePath,
    insidePath,
    page,
    SANDBOX_PAGES,
    SANDBOX_SEGMENT,
    type SandboxPageName,
} from "@intentic/sandbox-contract/app-routes";
import { nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

/* Switching sandboxes as a change of SCREEN, not just of daemon: what each sandbox was last showing is what it comes back
   to, in the frame the switch was made in. A real router in the shell's shape, so the screens recorded are the router's
   own landings and the switch's landing is a real navigation. */

// The node test environment has neither storage; windowStore itself is real (its own two-store rules are what
// make a screen this window's own).
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const activeSandboxId = ref<string | undefined>(`sb1`);
jest.mock("../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId }) }));
// The person's standing in the sandbox switched to: a guest's first screen is its chat, everyone else's the board.
const guest = ref(false);
jest.mock("../../client/sandbox/useRole", () => ({ useRole: () => ({ isGuest: guest, homeOnly: ref(false) }) }));

const view = { render: () => null };
const frames = [
    [`inside`, `/${SANDBOX_SEGMENT}/:sandbox`],
    [`home`, `/${HOME_SEGMENT}/:sandbox`],
] as const;
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/login`, component: view },
        { path: `/home/:sandbox?`, name: `home`, meta: { frame: `home` }, component: view },
        { path: `/s/:sandbox/${ACCOUNT_PAGES.account}`, meta: { frame: `inside`, page: `account` }, component: view },
        ...frames.flatMap(([frame, base]) =>
            // SAFETY: SANDBOX_PAGES is a const literal whose own keys are exactly SandboxPageName; Object.entries only widens them.
            (Object.entries(SANDBOX_PAGES) as [SandboxPageName, string][]).map(([name, pattern]) => ({
                path: `${base}/${pattern}`,
                meta: { frame, page: name },
                component: view,
            })),
        ),
    ],
});
const replace = jest.spyOn(router, `replace`);

const { foldedPath, homeEntryPath, landOnAfterSwitch, routeChoosesSandbox, sameViewPath, sandboxEntryPath, sectionEntryPath, unrolledPath } =
    await import("./sandboxScreen");
const { homeSection } = await import("../../lib/routes/homeSection");
const { installNavigation } = await import("../../workbench/navigation/navigation");
installNavigation(router);

// The switch made without a navigation (the phone's menu, a removal, a card opening another sandbox's agent): the id
// changes, the landing is a post-flush watcher, and its navigation is waited for.
const switchTo = async (sandboxId: string): Promise<void> => {
    const before = replace.mock.calls.length;
    activeSandboxId.value = sandboxId;
    await nextTick();
    await nextTick();
    if (replace.mock.calls.length > before) {
        await replace.mock.results.at(-1)?.value;
    }
};
// A navigation the router lands, under the sandbox its address names, as the route's own gate would select it.
const go = async (address: string): Promise<void> => {
    routeChoosesSandbox();
    const named = /^\/(?:s|home)\/([^/?#]+)/.exec(address)?.[1];
    if (named !== undefined && named !== `account`) {
        activeSandboxId.value = named;
    }
    await router.push(address);
};
const landedOn = (): string => router.currentRoute.value.fullPath;

const WORKSPACE = { id: `workspace`, page: { name: `workspace`, params: {} }, label: `Workspace` } as const;

beforeEach(async () => {
    local.clear();
    session.clear();
    guest.value = false;
    homeSection.value = undefined;
    await go(insidePath(`sb1`, page.workspace()));
    replace.mockClear();
});

describe(`landing on a switched-to sandbox`, () => {
    it(`comes back to the screen that sandbox was last on`, async () => {
        await go(insidePath(`sb1`, page.agents()));
        await switchTo(`sb2`);
        await go(insidePath(`sb2`, page.workspace(`src/foo.ts`)));

        await switchTo(`sb1`);
        expect(landedOn()).toBe(insidePath(`sb1`, page.agents()));

        await switchTo(`sb2`);
        expect(landedOn()).toBe(insidePath(`sb2`, page.workspace(`src/foo.ts`)));
    });

    it(`sends a sandbox this window has never shown to its own first screen, not to the current screen`, async () => {
        await go(insidePath(`sb1`, page.agent(`agent-of-sb1`)));

        await switchTo(`sb-fresh`);

        expect(landedOn()).toBe(insidePath(`sb-fresh`, page.agents()));
    });

    it(`lands a guest on its chat, the one screen it has in a box it was let into`, async () => {
        guest.value = true;

        await switchTo(`sb-fresh`);

        expect(landedOn()).toBe(insidePath(`sb-fresh`, page.chat()));
    });

    // `/` is Home since Home became the first screen: a switch made inside a sandbox must not bounce out to it.
    it.each([`/`, `agents`, homePath(`sb2`), insidePath(`sb1`, page.agents())])(`takes %s for no screen of the sandbox`, async (stored) => {
        session.set(`intentic.sandboxScreen.sb2`, stored);

        expect(sandboxEntryPath(`sb2`)).toBe(insidePath(`sb2`, page.agents()));
    });

    it(`reads a screen an older build kept, before frames, as the sandbox's`, () => {
        session.set(`intentic.sandboxScreen.sb2`, `/sandbox/secrets`);

        expect(sandboxEntryPath(`sb2`)).toBe(insidePath(`sb2`, page.sandboxSettings(`secrets`)));
    });

    it(`seeds a window that has never held the screen from the last window's`, async () => {
        local.set(`intentic.sandboxScreen.sb2`, insidePath(`sb2`, page.extension(`approvals`)));

        await switchTo(`sb2`);

        expect(landedOn()).toBe(insidePath(`sb2`, page.extension(`approvals`)));
    });

    it(`lands where a switch with a known destination asked, in either form of address`, async () => {
        landOnAfterSwitch(`sb2`, `/agents/cnv_9`);

        await switchTo(`sb2`);

        expect(landedOn()).toBe(insidePath(`sb2`, page.agent(`cnv_9`)));
    });

    it(`keeps an account page in view, of the sandbox switched to`, async () => {
        await go(insidePath(`sb1`, page.account(`appearance`)));

        await switchTo(`sb2`);

        expect(landedOn()).toBe(insidePath(`sb2`, page.account(`appearance`)));
    });
});

describe(`a switch the address made`, () => {
    it(`is the route's own answer, so nothing moves the reader again`, async () => {
        routeChoosesSandbox();
        await switchTo(`sb2`);

        expect(replace).not.toHaveBeenCalled();
    });

    it(`answers the next switch once its navigation has landed`, async () => {
        await go(insidePath(`sb2`, page.workspace()));

        await switchTo(`sb3`);

        expect(landedOn()).toBe(insidePath(`sb3`, page.agents()));
    });
});

describe(`what counts as a sandbox's screen`, () => {
    it(`never records a page outside the shell, and does not land while the reader is outside it`, async () => {
        await go(insidePath(`sb1`, page.agents()));
        await go(`/login`);

        await switchTo(`sb2`);

        expect(replace).not.toHaveBeenCalled();
        expect(sandboxEntryPath(`sb1`)).toBe(insidePath(`sb1`, page.agents()));
    });

    it(`does not record a navigation that failed: the screen nobody reached`, async () => {
        await go(insidePath(`sb1`, page.agents()));
        const refuse = router.beforeEach(() => false);
        await router.push(insidePath(`sb1`, page.workspace(`src/foo.ts`)));
        refuse();

        expect(sandboxEntryPath(`sb1`)).toBe(insidePath(`sb1`, page.agents()));
    });

    it(`records a page of the sandbox seen in Home's frame as its screen inside it`, async () => {
        await go(homePath(`sb1`, page.workspace(`src/a.ts`, { query: { agent: `cnv_1` } })));

        expect(sandboxEntryPath(`sb1`)).toBe(insidePath(`sb1`, page.workspace(`src/a.ts`, { query: { agent: `cnv_1` } })));
    });
});

describe(`a switch in Home's frame`, () => {
    it(`does nothing on Home with no sandbox named`, async () => {
        await go(homePath());

        await switchTo(`sb2`);

        expect(replace).not.toHaveBeenCalled();
    });

    it(`goes from one sandbox's home conversation to the other's`, async () => {
        await go(homePath(`sb1`));

        await switchTo(`sb2`);

        expect(landedOn()).toBe(homePath(`sb2`));
    });

    it(`lands on the section chosen there, at the screen that sandbox was last on in it when it has one`, async () => {
        await go(insidePath(`sb2`, page.workspace(`src/b.ts`)));
        homeSection.value = WORKSPACE;
        await go(homePath(`sb1`, page.workspace()));

        await switchTo(`sb3`);
        expect(landedOn()).toBe(homePath(`sb3`, page.workspace()));

        await switchTo(`sb2`);
        expect(landedOn()).toBe(homePath(`sb2`, page.workspace(`src/b.ts`)));
    });

    it(`keeps a sandbox's settings seen from Home in view, of the sandbox switched to`, async () => {
        await go(homePath(`sb1`, page.sandboxSettings(`models`)));

        await switchTo(`sb2`);

        expect(landedOn()).toBe(homePath(`sb2`, page.sandboxSettings(`models`)));
    });

    it(`is the section's own page for a sandbox never shown, and the remembered screen only when it is the section's`, () => {
        session.set(`intentic.sandboxScreen.sb2`, insidePath(`sb2`, page.workspace(`src/b.ts`, { query: { agent: `cnv_1` } })));
        session.set(`intentic.sandboxScreen.sb3`, insidePath(`sb3`, page.agents()));

        expect(sectionEntryPath(`sb-fresh`, WORKSPACE)).toBe(homePath(`sb-fresh`, page.workspace()));
        expect(sectionEntryPath(`sb2`, WORKSPACE)).toBe(homePath(`sb2`, page.workspace(`src/b.ts`, { query: { agent: `cnv_1` } })));
        expect(sectionEntryPath(`sb3`, WORKSPACE)).toBe(homePath(`sb3`, page.workspace()));
        expect(homeEntryPath(`sb3`)).toBe(homePath(`sb3`));
    });
});

/* One view, the rail unrolled or folded (2026-11-09): unrolling and folding change the address's frame and nothing else,
   and a look along the unrolled rail shows the same view of each sandbox. */
describe(`the rail unrolled and folded around the page on screen`, () => {
    const here = () => router.currentRoute.value;

    it(`unrolls around the same page of the same sandbox, whatever is open in it`, async () => {
        await go(insidePath(`sb1`, page.workspace(`src/a.ts`, { query: { agent: `cnv_1` } })));

        expect(unrolledPath(here())).toBe(homePath(`sb1`, page.workspace(`src/a.ts`, { query: { agent: `cnv_1` } })));
    });

    it(`folds back onto the same page, so the two are each other's way back`, async () => {
        await go(homePath(`sb1`, page.agent(`cnv_1`)));

        expect(foldedPath(here())).toBe(insidePath(`sb1`, page.agent(`cnv_1`)));
        expect(unrolledPath(here())).toBe(homePath(`sb1`, page.agent(`cnv_1`)));
    });

    it(`folds from Home's own page, which is no page of a sandbox, to where the sandbox was last left`, async () => {
        await go(insidePath(`sb1`, page.agents()));
        await go(homePath(`sb1`));

        expect(foldedPath(here())).toBe(insidePath(`sb1`, page.agents()));
    });

    it(`shows the view on screen of the sandbox pressed, on the screen it was last left on in that view`, async () => {
        await go(insidePath(`sb2`, page.workspace(`src/b.ts`)));
        await go(homePath(`sb1`, page.workspace(`src/a.ts`)));

        expect(sameViewPath(`sb2`, here())).toBe(homePath(`sb2`, page.workspace(`src/b.ts`)));
        expect(sameViewPath(`sb3`, here())).toBe(homePath(`sb3`, page.workspace()));
    });

    it(`shows the board of the sandbox pressed from an agent opened on another's, never that agent`, async () => {
        await go(homePath(`sb1`, page.agent(`cnv_1`)));

        expect(sameViewPath(`sb2`, here())).toBe(homePath(`sb2`, page.agents()));
    });

    it(`opens the sandbox pressed where Home opens it, around no page of a sandbox`, async () => {
        await go(homePath(`sb1`));
        expect(sameViewPath(`sb2`, here())).toBe(homePath(`sb2`));

        homeSection.value = WORKSPACE;
        expect(sameViewPath(`sb2`, here())).toBe(homePath(`sb2`, page.workspace()));
    });

    it(`folds onto another sandbox than the one on screen at the same view of it`, async () => {
        await go(homePath(`sb1`, page.agent(`cnv_1`)));

        expect(foldedPath(here(), `sb2`)).toBe(insidePath(`sb2`, page.agents()));
    });

    it(`lands a switch made without a navigation on the same view, not on what Home opens on`, async () => {
        homeSection.value = WORKSPACE;
        await go(homePath(`sb1`, page.agents()));

        await switchTo(`sb2`);

        expect(landedOn()).toBe(homePath(`sb2`, page.agents()));
    });
});
