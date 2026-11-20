import type { Geolocation } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, inject, type InjectionKey, type Ref } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { sandboxRawUpload } from "../../client/sandbox/sandboxRawUpload";
import { writeClipboard } from "@intentic/ui/clipboard";
import { useEndpoint } from "../../client/endpoint/useEndpoint";
import { elementAddress } from "../../client/endpoint/elementAddress";
import { useDownloadTools } from "./downloads/useDownloadTools";
import { usePageTools } from "./devtools/usePageTools";
import { usePermissionAsk } from "./siteInfo/usePermissionAsk";
import { useSiteInfo } from "./siteInfo/useSiteInfo";
import type { PictureGeometry } from "./uploads/dropPoint";
import { useDropFiles } from "./uploads/useDropFiles";
import { useFileTools } from "./uploads/useFileTools";

// What a browser window does besides showing its pages, drawn in the browser view's own chrome rather than Chromium's,
// which the picture never shows (schemas/browser-tools.ts): its downloads, the files a page asks for or has dropped on
// it, a site's permission asks and info, printing, a page's source and DevTools. One per view; LiveBrowser.vue mounts
// the pieces (downloads/, uploads/, siteInfo/, devtools/) and hands them this.

// Everything the tools reach outside the view, so a test hands in fakes through WINDOW_TOOLS_SEAMS.
export interface WindowToolsSeams {
    readonly browser: Pick<
        typeof sandboxRpc.browser,
        | `downloadTicket`
        | `saveDownload`
        | `cancelDownload`
        | `removeDownload`
        | `answerFileChooser`
        | `dropFiles`
        | `answerPermission`
        | `site`
        | `setSitePermission`
        | `clearSiteData`
        | `printPage`
        | `viewSource`
        | `devtools`
        | `startRecording`
        | `stopRecording`
    >;
    readonly upload: (file: File, id: string, onProgress: (sent: number) => void) => Promise<void>;
    // The sandbox's own address, as the editor reaches it; undefined while it has none yet.
    readonly base: () => string | undefined;
    // Starts a download in the person's own browser from an address, without leaving the page.
    readonly hand: (url: string) => void;
    readonly copy: (text: string) => Promise<void>;
    // The person's own location, asked of their own browser (which asks them); undefined when it will not say.
    readonly locate: () => Promise<Geolocation | undefined>;
    readonly uploadId: () => string;
}

// A minute is longer than anyone takes to answer their browser's own location prompt; a fix five minutes old will do.
const LOCATE_MS = 60_000;
const LOCATION_AGE_MS = 300_000;

const locateHere = (): Promise<Geolocation | undefined> =>
    new Promise((resolve) => {
        if (!(`geolocation` in navigator)) {
            resolve(undefined);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
            () => resolve(undefined),
            { timeout: LOCATE_MS, maximumAge: LOCATION_AGE_MS },
        );
    });

// Navigates a detached link rather than the page: an attachment answer never replaces what is on screen.
const handLink = (url: string): void => {
    const anchor = document.createElement(`a`);
    anchor.href = elementAddress(url);
    anchor.rel = `noopener`;
    anchor.click();
};

const realWindowToolsSeams = (): WindowToolsSeams => ({
    browser: sandboxRpc.browser,
    upload: (file, id, onProgress) => sandboxRawUpload(`POST /browser/uploads`, file, { query: { id, name: file.name }, onProgress }),
    base: () => useEndpoint().daemonBase.value,
    hand: handLink,
    copy: async (text) => {
        if (!(await writeClipboard(text))) {
            throw new Error(`The link could not be copied.`);
        }
    },
    locate: locateHere,
    uploadId: () => crypto.randomUUID().replaceAll(`-`, ``),
});

export const WINDOW_TOOLS_SEAMS: InjectionKey<() => WindowToolsSeams> = Symbol(`windowToolsSeams`);

export interface WindowToolsInput {
    readonly window: Ref<BrowserSession | undefined>;
    readonly page: Ref<BrowserPage | undefined>;
    // Whether the person has the window (their own, an agent's once its turn is over, or one they took over): only then
    // do its asks and tools reach them.
    readonly usable: Ref<boolean>;
    // The stage the picture is on, which takes files dropped from the desktop, and the picture's geometry, which maps a
    // drop to the page's own pixels.
    readonly stage: Ref<HTMLElement | null>;
    readonly geometry: () => PictureGeometry | undefined;
}

export const useWindowTools = (input: WindowToolsInput) => {
    const seams = inject(WINDOW_TOOLS_SEAMS, realWindowToolsSeams)();
    const name = computed(() => input.window.value?.name);
    const asked = <T>(read: (window: BrowserSession) => T | undefined) =>
        computed(() => (input.usable.value && input.window.value !== undefined ? read(input.window.value) : undefined));
    const downloads = useDownloadTools(seams, computed(() => input.window.value?.downloads));
    const files = useFileTools(seams, name, asked((window) => window.fileChooser));
    const drop = useDropFiles(seams, files, { window: name, page: input.page, usable: input.usable, stage: input.stage, geometry: input.geometry });
    return {
        downloads,
        files: { ...files, dragging: drop.dragging },
        permission: usePermissionAsk(seams, name, asked((window) => window.permissionAsk)),
        site: useSiteInfo(seams, name, input.page),
        page: usePageTools(seams, {
            window: name,
            page: input.page,
            usable: input.usable,
            recording: computed(() => input.window.value?.recording),
            showDownloads: () => (downloads.open.value = true),
        }),
    };
};

export type WindowTools = ReturnType<typeof useWindowTools>;
