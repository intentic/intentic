import { procedure } from "../protocol/route-meta.js";
import {
    AnswerFileChooserInputSchema,
    AnswerPermissionInputSchema,
    BrowserDownloadSchema,
    BrowserPageToolInputSchema,
    BrowserRecordingSchema,
    BrowserWindowInputSchema,
    DevToolsResultSchema,
    DownloadIdParamSchema,
    DownloadTicketSchema,
    DropFilesInputSchema,
    SaveDownloadInputSchema,
    SaveDownloadResultSchema,
    SetSitePermissionInputSchema,
    SitePermissionsSchema,
    SiteQuerySchema,
    ViewSourceResultSchema,
} from "../schemas/browser-tools.js";
import { OkSchema } from "../schemas/shared.js";

// Everything a browser window does besides its pages (schemas/browser-tools.ts): its downloads, the files and the
// permissions its pages ask for, and the tools around a page. Each is operating the window, the way taking the wheel
// over its picture is (the browser view's ticket is redeemed at maintainer), so every route here is too, reads
// included: a download's name and a site's permissions say where the person has been.
const browserRoute = procedure.meta({ floor: "maintainer", control: "never" });

export const browserContract = {
    downloads: browserRoute
        .route({
            method: "GET",
            path: "/browser/downloads",
            summary: "Every browser download",
            description:
                "Every download the sandbox's browser windows keep, newest first, whichever window it came from. A window's own state carries its profile's; this is all of them.",
        })
        .output(BrowserDownloadSchema.array()),
    downloadTicket: browserRoute
        .route({
            method: "POST",
            path: "/browser/downloads/{id}/ticket",
            summary: "Fetch a download onto your computer",
            description:
                "A short-lived ticket for one finished download's file. Opening the browser downloads file route with it streams the file to your own browser, which saves it where you keep downloads.",
        })
        .input(DownloadIdParamSchema)
        .output(DownloadTicketSchema),
    saveDownload: browserRoute
        .route({
            method: "POST",
            path: "/browser/downloads/{id}/save",
            summary: "Save a download into the workspace",
            description:
                "Copies one finished download into a folder of the workspace, `downloads/` unless you name another. A name already taken there gets a number added rather than replacing what is there.",
        })
        .input(SaveDownloadInputSchema)
        .output(SaveDownloadResultSchema),
    cancelDownload: browserRoute
        .route({
            method: "POST",
            path: "/browser/downloads/{id}/cancel",
            summary: "Stop a download",
            description: "Stops a download still arriving. One that already finished is left as it is.",
        })
        .input(DownloadIdParamSchema)
        .output(OkSchema),
    removeDownload: browserRoute
        .route({
            method: "DELETE",
            path: "/browser/downloads/{id}",
            summary: "Remove a download",
            description: "Stops it if it is still arriving, deletes its file from the sandbox and drops it from the list. A copy saved into the workspace stays.",
        })
        .input(DownloadIdParamSchema)
        .output(OkSchema),
    answerFileChooser: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/file-chooser",
            summary: "Answer a page's file chooser",
            description:
                "Hands the page the files you uploaded for it, as though you had picked them in its own dialog, or cancels the ask when none are named.",
        })
        .input(AnswerFileChooserInputSchema)
        .output(OkSchema),
    dropFiles: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/drop",
            summary: "Drop files onto a page",
            description:
                "Drops uploaded files onto a page at a point, as dragging them there from your desktop does: into the file field under it, or onto whatever takes a drop.",
        })
        .input(DropFilesInputSchema)
        .output(OkSchema),
    answerPermission: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/permission",
            summary: "Answer a site's permission ask",
            description:
                "Allows or blocks what a site asked for, remembered for that site in this window's profile. Allowing your location can carry it, and the page is told that is where you are.",
        })
        .input(AnswerPermissionInputSchema)
        .output(OkSchema),
    site: browserRoute
        .route({
            method: "GET",
            path: "/browser/windows/{name}/site",
            summary: "A site's permissions",
            description: "What one site may do in this window's profile: each permission this browser answers, allowed, blocked or asked each time.",
        })
        .input(SiteQuerySchema)
        .output(SitePermissionsSchema),
    setSitePermission: browserRoute
        .route({
            method: "PUT",
            path: "/browser/windows/{name}/site",
            summary: "Change a site's permission",
            description: "Allows, blocks, or goes back to asking for one permission of one site, in this window's profile, from the next time the site asks.",
        })
        .input(SetSitePermissionInputSchema)
        .output(OkSchema),
    clearSiteData: browserRoute
        .route({
            method: "DELETE",
            path: "/browser/windows/{name}/site",
            summary: "Clear a site's cookies and data",
            description:
                "Deletes everything one site keeps in this window's profile: cookies, storage, caches and its service workers. It signs you out of that site.",
        })
        .input(SiteQuerySchema)
        .output(OkSchema),
    printPage: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/pages/{pageId}/print",
            summary: "Print a page to PDF",
            description: "Prints a tab as a PDF, the way the browser's own print-to-PDF does, and lists it with the window's downloads.",
        })
        .input(BrowserPageToolInputSchema)
        .output(BrowserDownloadSchema),
    viewSource: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/pages/{pageId}/source",
            summary: "View a page's source",
            description: "Opens the page's source in a new tab of the same window, as view-source: does.",
        })
        .input(BrowserPageToolInputSchema)
        .output(ViewSourceResultSchema),
    startRecording: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/recording",
            summary: "Record a browser window",
            description:
                "Starts recording the window's picture as the sandbox streams it, sound not included. It stops when you stop it, or by itself at its longest, and is listed with the window's downloads as an MP4.",
        })
        .input(BrowserWindowInputSchema)
        .output(BrowserRecordingSchema),
    stopRecording: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/recording/stop",
            summary: "Stop recording a browser window",
            description: "Stops the window's recording and lists it with the window's downloads, as an MP4 of everything since it started.",
        })
        .input(BrowserWindowInputSchema)
        .output(BrowserDownloadSchema),
    devtools: browserRoute
        .route({
            method: "POST",
            path: "/browser/windows/{name}/pages/{pageId}/devtools",
            summary: "Open DevTools for a page",
            description:
                "Chromium's own DevTools for one tab: where its frontend is served, through this sandbox, with a ticket of its own. It inspects the page itself, so it can read and change anything the page can.",
        })
        .input(BrowserPageToolInputSchema)
        .output(DevToolsResultSchema),
};
