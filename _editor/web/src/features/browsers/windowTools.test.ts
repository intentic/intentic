import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { unstubbed } from "@intentic/testing";
import { nextTick, ref } from "vue";
import { inSetup, provided } from "../../testing/inSetup";
import { devtoolsFrameSrc } from "./devtools/devtoolsAddress";
import { downloadLine, ringPercent } from "./downloads/downloadWords";
import { siteOf } from "./siteInfo/useSiteInfo";
import { WINDOW_TOOLS_SEAMS, type WindowToolsSeams, useWindowTools } from "./windowTools";

/* What a browser window does besides its pages, as the view drives it through its seams: a download is fetched with a
   ticket at the sandbox's own address or saved where the person picked, a page's file chooser is answered with what
   was uploaded (one file where it takes one, none to cancel), a location goes along with allowing a site to know it,
   and DevTools opens at the frontend's path told to connect to the page's socket on the same address. */

const NOW = 1_800_000_000_000;

const download = (change: Partial<BrowserDownload> = {}): BrowserDownload => ({
    id: `dl-1`,
    name: `report.pdf`,
    url: `https://example.com/report.pdf`,
    state: `done`,
    receivedBytes: 2048,
    totalBytes: 2048,
    startedAt: NOW - 60_000,
    finishedAt: NOW - 60_000,
    ...change,
});

const fallbackChooser = () => ({ id: `none`, pageId: `p1`, multiple: false });

const PAGE: BrowserPage = { id: `p1`, url: `https://maps.example/where`, active: true };

const windowWith = (change: Partial<BrowserSession> = {}): BrowserSession => ({
    name: `browser-own`,
    label: `Maps`,
    server: `_own`,
    running: true,
    activityAt: NOW,
    pages: [PAGE],
    own: true,
    ...change,
});

// The seams as one test needs them: every call recorded, anything not stubbed naming itself when reached.
const stand = (browser: Partial<WindowToolsSeams[`browser`]>, change: Partial<Omit<WindowToolsSeams, `browser`>> = {}) => {
    const calls: { readonly what: string; readonly input: unknown }[] = [];
    const handed: string[] = [];
    const seams: WindowToolsSeams = {
        browser: unstubbed<WindowToolsSeams[`browser`]>(`browser`, browser),
        upload: async (file, id, onProgress) => {
            onProgress(file.size);
            calls.push({ what: `upload`, input: { name: file.name, id } });
        },
        base: () => `https://sbx-1.intentic.dev`,
        hand: (url) => handed.push(url),
        copy: async () => undefined,
        locate: async () => ({ latitude: 52.23, longitude: 21.01, accuracy: 40 }),
        uploadId: () => `upload-${String(calls.length + 1)}`,
        ...change,
    };
    const window = ref<BrowserSession | undefined>(windowWith());
    const usable = ref(true);
    const { result } = inSetup(
        () => useWindowTools({ window, page: ref(PAGE), usable, stage: ref(null), geometry: () => undefined }),
        { provides: [provided(WINDOW_TOOLS_SEAMS, () => seams)] },
    );
    return { tools: result, calls, handed, window, usable };
};

describe(`downloads`, () => {
    test(`saving to the computer hands the person's browser the file's ticketed address on the sandbox`, async () => {
        const { tools, handed } = stand({ downloadTicket: async () => ({ ticket: `t k`, expiresAt: NOW }) });
        await tools.downloads.toComputer(download());
        expect(handed).toEqual([`https://sbx-1.intentic.dev/browser/downloads/file?ticket=t+k`]);
    });

    test(`saving to the workspace goes to the folder picked, and says where it landed`, async () => {
        const saved: unknown[] = [];
        const { tools } = stand({
            saveDownload: async (input) => {
                saved.push(input);
                return { path: `inbox/report.pdf` };
            },
        });
        await tools.downloads.toWorkspace(download(), `inbox`);
        expect(saved).toEqual([{ id: `dl-1`, folder: `inbox` }]);
        expect(tools.downloads.said.value[`dl-1`]).toEqual({ ok: true, text: `inbox/report.pdf` });
    });

    test(`a refusal is said on the download it was about`, async () => {
        const { tools } = stand({
            saveDownload: async () => {
                throw new Error(`Pick a folder inside the workspace.`);
            },
        });
        await tools.downloads.toWorkspace(download(), `../out`);
        expect(tools.downloads.said.value[`dl-1`]).toEqual({ ok: false, text: `Pick a folder inside the workspace.` });
    });

    test(`the ring counts what is arriving with a known size, and is absent when nothing arrives`, () => {
        expect(ringPercent([download()])).toBeUndefined();
        expect(ringPercent([download({ state: `progress`, receivedBytes: 512, totalBytes: 2048 }), download({ id: `b`, state: `progress`, receivedBytes: 512, totalBytes: 2048 })])).toBe(25);
        expect(ringPercent([download({ state: `progress`, receivedBytes: 512, totalBytes: undefined })])).toBe(0);
    });

    test(`a finished download's line is its size, when, and where from`, () => {
        expect(downloadLine(download(), NOW)).toBe(`2.0 KB · 1m ago · example.com`);
    });
});

describe(`a page's file chooser`, () => {
    test(`is answered with every file uploaded, under their ids, where it takes several`, async () => {
        const answered: unknown[] = [];
        const { tools, calls, window } = stand({
            answerFileChooser: async (input) => {
                answered.push(input);
                return { ok: true };
            },
        });
        window.value = windowWith({ fileChooser: { id: `c1`, pageId: `p1`, multiple: true } });
        await nextTick();
        const chooser = tools.files.chooser.value;
        expect(chooser).toEqual({ id: `c1`, pageId: `p1`, multiple: true });
        await tools.files.pick(chooser ?? fallbackChooser(), [new File([`a`], `a.txt`), new File([`bb`], `b.txt`)]);
        expect(calls.map((call) => call.input)).toEqual([
            { name: `a.txt`, id: `upload-1` },
            { name: `b.txt`, id: `upload-2` },
        ]);
        expect(answered).toEqual([{ name: `browser-own`, chooser: `c1`, uploads: [`upload-1`, `upload-2`] }]);
    });

    test(`takes one file where the page takes one, and none to cancel`, async () => {
        const answered: unknown[] = [];
        const { tools } = stand({
            answerFileChooser: async (input) => {
                answered.push(input);
                return { ok: true };
            },
        });
        const single = { id: `c2`, pageId: `p1`, multiple: false };
        await tools.files.pick(single, [new File([`a`], `a.txt`), new File([`b`], `b.txt`)]);
        await tools.files.cancel(single);
        expect(answered).toEqual([
            { name: `browser-own`, chooser: `c2`, uploads: [`upload-1`] },
            { name: `browser-own`, chooser: `c2`, uploads: [] },
        ]);
    });

    test(`is not the person's while an agent has the window`, async () => {
        const { tools, window, usable } = stand({});
        usable.value = false;
        window.value = windowWith({ fileChooser: { id: `c3`, pageId: `p1`, multiple: false } });
        await nextTick();
        expect(tools.files.chooser.value).toBeUndefined();
    });
});

describe(`a site's permission`, () => {
    test(`allowing a location sends the person's own along`, async () => {
        const answered: unknown[] = [];
        const { tools, window } = stand({
            answerPermission: async (input) => {
                answered.push(input);
                return { ok: true };
            },
        });
        window.value = windowWith({ permissionAsk: { id: `a1`, pageId: `p1`, origin: `https://maps.example`, permission: `geolocation` } });
        await nextTick();
        await tools.permission.answer(`allow`);
        expect(answered).toEqual([{ name: `browser-own`, ask: `a1`, setting: `allow`, location: { latitude: 52.23, longitude: 21.01, accuracy: 40 } }]);
    });

    test(`blocking asks nothing of the person's browser`, async () => {
        const answered: unknown[] = [];
        const { tools, window } = stand(
            {
                answerPermission: async (input) => {
                    answered.push(input);
                    return { ok: true };
                },
            },
            {
                locate: async () => {
                    throw new Error(`asked for a location on a block`);
                },
            },
        );
        window.value = windowWith({ permissionAsk: { id: `a2`, pageId: `p1`, origin: `https://maps.example`, permission: `geolocation` } });
        await nextTick();
        await tools.permission.answer(`block`);
        expect(answered).toEqual([{ name: `browser-own`, ask: `a2`, setting: `block` }]);
    });

    test(`the site is a web page's origin, and nothing else`, () => {
        expect(siteOf(`https://maps.example/where?x=1`)).toBe(`https://maps.example`);
        expect(siteOf(`about:blank`)).toBeUndefined();
        expect(siteOf(`view-source:https://maps.example/`)).toBeUndefined();
        expect(siteOf(undefined)).toBeUndefined();
    });
});

describe(`DevTools`, () => {
    test(`opens the frontend at its path, told to connect to the page's socket on the same address`, async () => {
        const { tools } = stand({ devtools: async () => ({ path: `/browser/devtools/T/inspector.html`, socket: `/browser/devtools/T/ws/page/ABC`, expiresAt: NOW }) });
        tools.page.toggleDevtools();
        // The mint is a promise the toggle does not hand back: a few turns of the queue let it land.
        for (let turn = 0; turn < 5 && tools.page.devtools.value === undefined; turn += 1) {
            await Promise.resolve();
        }
        expect(tools.page.devtools.value).toEqual({
            src: `https://sbx-1.intentic.dev/browser/devtools/T/inspector.html?wss=sbx-1.intentic.dev/browser/devtools/T/ws/page/ABC`,
            pageId: `p1`,
        });
        tools.page.toggleDevtools();
        expect(tools.page.devtools.value).toBeUndefined();
    });

    test(`a loopback sandbox is a plain socket, and a sandbox under a path keeps it`, () => {
        const opened = { path: `/browser/devtools/T/inspector.html`, socket: `/browser/devtools/T/ws/page/ABC` };
        expect(devtoolsFrameSrc(`http://127.0.0.1:47110`, opened)).toBe(`http://127.0.0.1:47110/browser/devtools/T/inspector.html?ws=127.0.0.1:47110/browser/devtools/T/ws/page/ABC`);
        expect(devtoolsFrameSrc(`https://edge.example/s/abc/`, opened)).toBe(
            `https://edge.example/s/abc/browser/devtools/T/inspector.html?wss=edge.example/s/abc/browser/devtools/T/ws/page/ABC`,
        );
        expect(devtoolsFrameSrc(undefined, opened)).toBeUndefined();
    });
});

describe(`recording`, () => {
    test(`Record starts the window's recording, and once its state says one is under way, the same verb stops it and opens the downloads it is listed in`, async () => {
        const asked: string[] = [];
        const { tools, window } = stand({
            startRecording: async (input) => {
                asked.push(`start ${input.name}`);
                return { startedAt: NOW, maxSeconds: 300 };
            },
            stopRecording: async (input) => {
                asked.push(`stop ${input.name}`);
                return download({ id: `rec-1`, name: `Recording Maps 2027-01-15 08.00.00.mp4` });
            },
        });
        expect(tools.page.recording.value).toBeUndefined();
        await tools.page.toggleRecording();
        expect(asked).toEqual([`start browser-own`]);
        window.value = windowWith({ recording: { startedAt: NOW, maxSeconds: 300 } });
        await nextTick();
        expect(tools.page.recording.value).toEqual({ startedAt: NOW, maxSeconds: 300 });
        expect(tools.downloads.open.value).toBe(false);
        await tools.page.toggleRecording();
        expect(asked).toEqual([`start browser-own`, `stop browser-own`]);
        expect(tools.downloads.open.value).toBe(true);
    });

    test(`a window the sandbox cannot record says why, in the menu's own words`, async () => {
        const { tools } = stand({
            startRecording: async () => {
                throw new Error(`This window can't be recorded: the sandbox records only a window it streams the new way.`);
            },
        });
        await tools.page.toggleRecording();
        expect(tools.page.error.value).toBe(`This window can't be recorded: the sandbox records only a window it streams the new way.`);
    });
});
