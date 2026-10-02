import "@intentic/testing/dom";
import {
    DESKTOP_CLEAR_NOTICES_LINK,
    desktopBadgeLink,
    desktopNoticeLink,
    desktopNotices,
    desktopNoticeSetting,
    desktopWithdrawLink,
    receiveDesktopNoticeSetting,
} from "./desktopNotices";

// The links the desktop app reads its notifications and its icon's mark off (setup_link.rs drops one out of shape
// whole, so each is held to the app's shape here, where it is built).

const params = (link: string): Record<string, string> => Object.fromEntries(new URL(link).searchParams);
const param = (link: string, name: string): string | null => new URL(link).searchParams.get(name);

describe(`whether the app takes notifications`, () => {
    afterEach(() => {
        delete window.__INTENTIC_DESKTOP__;
    });

    it(`is only when the app says so`, () => {
        expect(desktopNotices()).toBe(false);
        window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `i`, update: null };
        expect(desktopNotices()).toBe(false);
        window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `i`, update: null, notices: true };
        expect(desktopNotices()).toBe(true);
    });
});

describe(`the badge link`, () => {
    it(`carries the mark, the count for an ask, the tooltip and both images`, () => {
        const link = desktopBadgeLink({ mark: `asks`, count: 3, tooltip: `3 need you`, icon: `iVBOR-w_`, overlay: `iVBORxx` });
        expect(new URL(link).host).toBe(`badge`);
        expect(params(link)).toEqual({ mark: `asks`, count: `3`, tooltip: `3 need you`, icon: `iVBOR-w_`, overlay: `iVBORxx` });
    });

    it(`counts only an ask, and says nothing it has not got`, () => {
        expect(params(desktopBadgeLink({ mark: `working`, count: 2 }))).toEqual({ mark: `working` });
        expect(params(desktopBadgeLink({ mark: `none`, count: 0, tooltip: `  ` }))).toEqual({ mark: `none` });
    });

    it(`holds the tooltip to one bounded line`, () => {
        expect(param(desktopBadgeLink({ mark: `done`, count: 0, tooltip: `two\nlines` }), `tooltip`)).toBe(`two lines`);
        expect(Array.from(param(desktopBadgeLink({ mark: `done`, count: 0, tooltip: `ż`.repeat(150) }), `tooltip`) ?? ``)).toHaveLength(100);
    });
});

describe(`the notification link`, () => {
    it(`carries what the app shows and where a press goes`, () => {
        const link = desktopNoticeLink({
            key: `asks:sbx/a1`,
            kind: `asks`,
            title: `Fix the login`,
            body: `Needs you · Permission`,
            path: `/?sandbox=sbx&conversation=a1`,
            silent: true,
        });
        expect(new URL(link).host).toBe(`notice`);
        expect(params(link)).toEqual({
            do: `show`,
            key: `asks:sbx/a1`,
            kind: `asks`,
            title: `Fix the login`,
            body: `Needs you · Permission`,
            path: `/?sandbox=sbx&conversation=a1`,
            silent: `1`,
        });
    });

    it(`drops a route that is not the page's own, and an empty line`, () => {
        for (const path of [`//evil.example`, `https://evil.example`, `agents`, `/\\evil`]) {
            expect(params(desktopNoticeLink({ key: `k`, kind: `finished`, title: `T`, path, silent: false }))).toEqual({
                do: `show`,
                key: `k`,
                kind: `finished`,
                title: `T`,
            });
        }
        expect(param(desktopNoticeLink({ key: `k`, kind: `finished`, title: `T`, body: `\n`, silent: false }), `body`)).toBeNull();
    });

    it(`never sends an empty title, and holds each line to what the app takes`, () => {
        expect(param(desktopNoticeLink({ key: `k`, kind: `asks`, title: ` `, silent: false }), `title`)).toBe(`Intentic`);
        const long = desktopNoticeLink({ key: `k`.repeat(300), kind: `asks`, title: `t`.repeat(300), body: `b`.repeat(500), silent: false });
        expect([`key`, `title`, `body`].map((name) => param(long, name)?.length)).toEqual([200, 200, 400]);
    });

    it(`takes one down by its key, or all of them`, () => {
        expect(params(desktopWithdrawLink(`asks:sbx/a1`))).toEqual({ do: `withdraw`, key: `asks:sbx/a1` });
        expect(params(DESKTOP_CLEAR_NOTICES_LINK)).toEqual({ do: `clear` });
    });
});

// What the app found of the system's own switch (notice.rs `Standing`), which the settings say beside theirs.
describe(`the system's word on notifications`, () => {
    it(`is kept as the app said it`, () => {
        receiveDesktopNoticeSetting(`off-user`);
        expect(desktopNoticeSetting.value).toBe(`off-user`);
        receiveDesktopNoticeSetting(`on`);
        expect(desktopNoticeSetting.value).toBe(`on`);
    });

    it(`is unknown for a word the page does not know`, () => {
        receiveDesktopNoticeSetting(`off-user`);
        receiveDesktopNoticeSetting(`muted`);
        expect(desktopNoticeSetting.value).toBe(`unknown`);
        receiveDesktopNoticeSetting(undefined);
        expect(desktopNoticeSetting.value).toBe(`unknown`);
    });
});
