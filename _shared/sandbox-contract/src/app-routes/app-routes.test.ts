import { fillPattern, matchPattern } from "./patterns.js";
import { page, PAGE_PATTERNS, type PageLink, withExtras } from "./app-pages.js";
import { floatingPath, homePath, insidePath, localPath, parseAppPath, parseFloatingPath, topPath } from "./paths.js";
import { legacyPathOf, legacySandbox, legacyTarget } from "./legacy.js";

/* Every address the editor answers is made here and read back here, so these pin the scheme itself: what an address
   says about its frame, its sandbox and its page, and what the addresses from before frames still mean. */

const SB = `3f2a9c1b4d5e`;

describe(`the grammar of a pattern`, () => {
    it(`writes and reads a plain parameter, encoding what a segment cannot hold`, () => {
        expect(fillPattern(`agents/:id`, { id: `a b/c` })).toBe(`agents/a%20b%2Fc`);
        expect(matchPattern(`agents/:id`, `/agents/a%20b%2Fc`)).toEqual({ id: `a b/c` });
    });

    it(`keeps a file's slashes as slashes and drops an empty optional tail`, () => {
        expect(fillPattern(`workspace/:path(.*)*`, { path: `src/a b.ts` })).toBe(`workspace/src/a%20b.ts`);
        expect(fillPattern(`workspace/:path(.*)*`, {})).toBe(`workspace`);
        expect(matchPattern(`workspace/:path(.*)*`, `workspace/src/a%20b.ts`)).toEqual({ path: `src/a b.ts` });
        expect(matchPattern(`workspace/:path(.*)*`, `workspace`)).toEqual({});
    });

    it(`refuses to write a link that leaves out what its page needs`, () => {
        expect(() => fillPattern(`agents/:id`, {})).toThrow(/:id/);
    });

    it(`reads only the values an alternation names`, () => {
        expect(matchPattern(`floating/:panel(chat|terminal)`, `floating/chat`)).toEqual({ panel: `chat` });
        expect(matchPattern(`floating/:panel(chat|terminal)`, `floating/files`)).toBeUndefined();
    });
});

describe(`a link's address in each frame`, () => {
    it(`puts a sandbox page inside its sandbox`, () => {
        expect(insidePath(SB, page.agents())).toBe(`/s/${SB}/agents`);
        expect(insidePath(SB, page.agent(`c1`, { query: { view: `changes` } }))).toBe(`/s/${SB}/agents/c1?view=changes`);
        expect(insidePath(SB, page.workspace(`src/main.ts`))).toBe(`/s/${SB}/workspace/src/main.ts`);
        expect(insidePath(SB, page.sandboxSettings(`agent`, { query: { section: `tools` }, hash: `#voice` }))).toBe(
            `/s/${SB}/settings/agent?section=tools#voice`,
        );
        expect(insidePath(SB)).toBe(`/s/${SB}`);
    });

    it(`puts the same page in Home's frame under the same relative path`, () => {
        expect(homePath(SB, page.agents())).toBe(`/home/${SB}/agents`);
        expect(homePath(SB)).toBe(`/home/${SB}`);
        expect(homePath()).toBe(`/home`);
    });

    it(`draws the account's pages in either frame, naming a sandbox only inside one`, () => {
        expect(homePath(SB, page.account(`appearance`))).toBe(`/home/account/appearance`);
        expect(homePath(undefined, page.deletedSandboxes())).toBe(`/home/deleted-sandboxes`);
        expect(insidePath(SB, page.account(`appearance`))).toBe(`/s/${SB}/account/appearance`);
    });

    it(`will not draw a sandbox's page in Home's frame without its sandbox`, () => {
        expect(() => homePath(undefined, page.agents())).toThrow(/sandbox/);
    });

    it(`leaves out a query key with no value`, () => {
        expect(insidePath(SB, page.agents({ query: { focus: undefined, mine: `` } }))).toBe(`/s/${SB}/agents`);
    });

    it(`merges extras over a link`, () => {
        const merged = withExtras(page.agents({ query: { focus: `a` } }), { query: { view: `x` }, hash: `top` });
        expect(insidePath(SB, merged)).toBe(`/s/${SB}/agents?focus=a&view=x#top`);
    });

    it(`addresses the pages that are no sandbox's, and a floating window`, () => {
        expect(topPath(`login`, {}, { returnTo: `/s/${SB}/agents` })).toBe(`/login?returnTo=%2Fs%2F${SB}%2Fagents`);
        expect(topPath(`invite`, { token: `t1` })).toBe(`/invite/t1`);
        expect(topPath(`root`)).toBe(`/`);
        expect(floatingPath(SB, `chat`)).toBe(`/s/${SB}/floating/chat`);
        expect(localPath(`account`, { tab: `data` })).toBe(`/account/data`);
    });
});

describe(`reading an address back`, () => {
    const roundTrips: readonly PageLink[] = [
        page.chat(),
        page.agents(),
        page.agent(`c1`),
        page.agentPage(`c1`, `p9`),
        page.workspace(),
        page.workspace(`docs/a b.md`),
        page.browsers(),
        page.browsers(`app:shop/web`),
        page.devices(),
        page.capabilities(),
        page.capabilities(`github`),
        page.extension(`pipelines`),
        page.extension(`e-urzad`, `office-ed`),
        page.sandboxSettings(),
        page.sandboxSettings(`models`),
        page.terminal(),
        page.menu(),
    ];

    it.each(roundTrips.map((link) => [link.page, link] as const))(`reads %s back from both frames`, (_name, link) => {
        const params = Object.fromEntries(Object.entries(link.params).filter((entry): entry is [string, string] => entry[1] !== undefined));
        expect(parseAppPath(insidePath(SB, link))).toEqual({ frame: { kind: `inside`, sandbox: SB }, page: { name: link.page, params } });
        expect(parseAppPath(homePath(SB, link))).toEqual({ frame: { kind: `home`, sandbox: SB }, page: { name: link.page, params } });
    });

    it(`reads the frames with no page, and the account's pages in Home's frame`, () => {
        expect(parseAppPath(`/s/${SB}`)).toEqual({ frame: { kind: `inside`, sandbox: SB } });
        expect(parseAppPath(`/home/${SB}?x=1`)).toEqual({ frame: { kind: `home`, sandbox: SB } });
        expect(parseAppPath(`/home`)).toEqual({ frame: { kind: `home` } });
        expect(parseAppPath(`/home/account/data#voice`)).toEqual({ frame: { kind: `home` }, page: { name: `account`, params: { tab: `data` } } });
    });

    it(`reads nothing of an address that is no shell page's`, () => {
        expect(parseAppPath(`/login`)).toBeUndefined();
        expect(parseAppPath(`/agents`)).toBeUndefined();
        expect(parseAppPath(`/s/${SB}/nowhere`)).toBeUndefined();
        expect(parseAppPath(`/s/${SB}/floating/chat`)).toBeUndefined();
        expect(parseFloatingPath(`/s/${SB}/floating/chat`)).toEqual({ sandbox: SB, panel: `chat` });
        expect(parseFloatingPath(`/s/${SB}/floating/files`)).toBeUndefined();
    });

    it(`has one pattern per page, none a prefix of a frame's own segment`, () => {
        for (const pattern of Object.values(PAGE_PATTERNS)) {
            expect(pattern.startsWith(`/`)).toBe(false);
            expect(pattern.split(`/`)[0]).not.toBe(`floating`);
        }
    });
});

describe(`the addresses from before frames`, () => {
    it.each([
        [`/agents`, `inside`, `/s/${SB}/agents`],
        [`/agents/c1?view=changes`, `inside`, `/s/${SB}/agents/c1?view=changes`],
        [`/agents/c1/pages/p9`, `inside`, `/s/${SB}/agents/c1/pages/p9`],
        [`/needs?focus=c1`, `inside`, `/s/${SB}/agents?focus=c1`],
        [`/chat`, `inside`, `/s/${SB}/chat`],
        [`/workspace/src/a.ts`, `inside`, `/s/${SB}/workspace/src/a.ts`],
        [`/browsers/app:shop/web`, `inside`, `/s/${SB}/browsers/app:shop/web`],
        [`/desktop`, `inside`, `/s/${SB}/browsers/desktop`],
        [`/preview?target=shop`, `inside`, `/s/${SB}/browsers/preview:shop`],
        [`/devices`, `inside`, `/s/${SB}/devices`],
        [`/sandbox/devices?machine=m1`, `inside`, `/s/${SB}/devices?machine=m1`],
        [`/capabilities/github?edit=i1`, `inside`, `/s/${SB}/capabilities/github?edit=i1`],
        [`/connect?provider=claude#x`, `inside`, `/s/${SB}/settings/models?provider=claude#x`],
        [`/ext/e-urzad/office-ed`, `inside`, `/s/${SB}/ext/e-urzad/office-ed`],
        [`/sandbox`, `inside`, `/s/${SB}/settings`],
        [`/sandbox/models`, `inside`, `/s/${SB}/settings/models`],
        [`/sandbox/audit`, `inside`, `/s/${SB}/settings/activity?section=audit`],
        [`/sandbox/audit?section=keeping`, `inside`, `/s/${SB}/settings/retention`],
        [`/sandbox/areas`, `inside`, `/s/${SB}/settings/access?section=areas`],
        [`/terminal`, `inside`, `/s/${SB}/terminal`],
        [`/menu`, `inside`, `/s/${SB}/menu`],
        [`/settings/appearance`, `home`, `/home/account/appearance`],
        [`/settings`, `home`, `/home/account`],
        [`/deleted-sandboxes`, `home`, `/home/deleted-sandboxes`],
        [`/sandbox/deleted`, `home`, `/home/deleted-sandboxes`],
    ] as const)(`%s means its page, %s`, (old, frame, now) => {
        const target = legacyTarget(old);
        expect(target?.frame).toBe(frame);
        if (target !== undefined) {
            expect(target.frame === `inside` ? insidePath(SB, target.link) : homePath(SB, target.link)).toBe(now);
        }
    });

    it(`takes the sandbox an old link named out of the page's query, for the reader to read`, () => {
        expect(legacySandbox(`/agents/c1?sandbox=${SB}&view=changes`)).toBe(SB);
        expect(legacyTarget(`/agents/c1?sandbox=${SB}&view=changes`)?.link.query).toEqual({ view: `changes` });
        expect(legacySandbox(`/agents`)).toBeUndefined();
    });

    it(`is no address of today's scheme or a top page`, () => {
        expect(legacyTarget(`/s/${SB}/agents`)).toBeUndefined();
        expect(legacyTarget(`/home`)).toBeUndefined();
        expect(legacyTarget(`/login`)).toBeUndefined();
    });

    it(`writes a link back in the old form, for an app that reads that form`, () => {
        expect(legacyPathOf(page.agent(`c1`), SB)).toBe(`/agents/c1?sandbox=${SB}`);
        expect(legacyPathOf(page.agentPage(`c1`, `p9`))).toBe(`/agents/c1/pages/p9`);
        expect(legacyPathOf(page.agent(`c1`, { query: { view: `changes` } }), SB)).toBe(`/agents/c1?view=changes&sandbox=${SB}`);
        expect(legacyPathOf(page.menu())).toBe(`/menu`);
    });
});
