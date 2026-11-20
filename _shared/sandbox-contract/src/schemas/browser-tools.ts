import { z } from "zod";

// What a browser window does besides showing pages, which a desktop browser draws in its own chrome and the picture of
// one never shows: its downloads, the file a page asks for, the permission a site asks for, and the tools around a page
// (print, its source, DevTools). The daemon holds each (browser/downloads, uploads, permissions, devtools); the window's
// state carries what is pending, and the routes in contracts/browser.contract.ts answer it.

export const BrowserDownloadSchema = z.object({
    id: z.string().describe("Stable for the life of the download: what the routes below take."),
    name: z.string().describe("The file's name, as the site suggested it."),
    url: z.string().describe("Where it came from. A printed page is the page's own address."),
    state: z
        .enum(["progress", "done", "canceled", "failed"])
        .describe("Still arriving, finished, stopped by you, or broken off by the browser or the site."),
    receivedBytes: z.number().describe("How much has arrived so far."),
    totalBytes: z.number().optional().describe("How big it is, when the site said. Absent for a size nobody announced."),
    startedAt: z.number().describe("When it started, in milliseconds."),
    finishedAt: z.number().optional().describe("When it finished, failed or was stopped, in milliseconds."),
});
export type BrowserDownload = z.infer<typeof BrowserDownloadSchema>;

// A page's <input type=file> asking for files. Chromium's own dialog would open on the sandbox's disk, so the daemon
// holds the ask instead, and the person's own file picker answers it.
export const BrowserFileChooserSchema = z.object({
    id: z.string().describe("Which ask this is: what the answer names."),
    pageId: z.string().describe("Which page asked."),
    multiple: z.boolean().describe("The page takes several files at once."),
    accept: z
        .array(z.string())
        .optional()
        .describe("What the page says it takes: extensions (.pdf) and media types (image/*), as its accept attribute lists them."),
});
export type BrowserFileChooser = z.infer<typeof BrowserFileChooserSchema>;

// The permissions a site can ask a person for, the ones this browser answers.
export const BrowserPermissionSchema = z.enum(["notifications", "geolocation", "camera", "microphone", "clipboard-read"]);
export type BrowserPermission = z.infer<typeof BrowserPermissionSchema>;
export const BROWSER_PERMISSIONS = BrowserPermissionSchema.options;

// A site's standing answer for one permission: allowed, blocked, or asked each time (nothing decided).
export const PermissionSettingSchema = z.enum(["allow", "block", "ask"]);
export type PermissionSetting = z.infer<typeof PermissionSettingSchema>;

export const BrowserPermissionAskSchema = z.object({
    id: z.string().describe("Which ask this is: what the answer names."),
    pageId: z.string().describe("Which page asked."),
    origin: z.string().describe("The site asking, as scheme://host[:port]: what a decision is remembered for."),
    permission: BrowserPermissionSchema.describe("What it asks for."),
    // Camera and microphone: there is no device in the sandbox, so the page was told so at once and this only says it.
    unavailable: z
        .literal(true)
        .optional()
        .describe("The sandbox has nothing to give: no camera or microphone. The page was already told no; this says it happened."),
});
export type BrowserPermissionAsk = z.infer<typeof BrowserPermissionAskSchema>;

const WindowParams = { name: z.string().describe("Which browser window.") };

export const DownloadIdParamSchema = z.object({ id: z.string().describe("Which download.") });

export const DownloadTicketSchema = z.object({
    ticket: z.string().describe("Opens the download's file once, for a few minutes, at the browser downloads file route."),
    expiresAt: z.number().describe("When the ticket stops working, in milliseconds."),
});

export const SaveDownloadInputSchema = z.object({
    id: z.string().describe("Which download."),
    folder: z
        .string()
        .optional()
        .describe("The workspace folder to save it in, relative to the workspace root. Absent saves into `downloads/`, made if missing."),
});
export const SaveDownloadResultSchema = z.object({
    path: z.string().describe("Where it was saved, relative to the workspace root. A name already taken gets a number added."),
});

export const AnswerFileChooserInputSchema = z.object({
    ...WindowParams,
    chooser: z.string().describe("Which ask: the file chooser's id from the window's state."),
    uploads: z
        .array(z.string())
        .optional()
        .describe("The uploads to hand the page, by the ids they were uploaded under. Absent or empty cancels, as closing the picker does."),
});

export const DropFilesInputSchema = z.object({
    ...WindowParams,
    pageId: z.string().describe("The page they were dropped on."),
    x: z.number().describe("Where, in the page's own CSS pixels from its top-left corner."),
    y: z.number().describe("Where, in the page's own CSS pixels from its top-left corner."),
    uploads: z.array(z.string()).min(1).describe("The uploads dropped, by the ids they were uploaded under."),
});

export const GeolocationSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).describe("How sure, in metres."),
});
export type Geolocation = z.infer<typeof GeolocationSchema>;

export const AnswerPermissionInputSchema = z.object({
    ...WindowParams,
    ask: z.string().describe("Which ask: its id from the window's state."),
    setting: z.enum(["allow", "block"]).describe("The answer, remembered for the site."),
    location: GeolocationSchema.optional().describe("Your own location, for a site allowed to know it: what the page is then told it is."),
});

export const SiteQuerySchema = z.object({
    ...WindowParams,
    origin: z.string().describe("The site, as scheme://host[:port]."),
});

export const SitePermissionsSchema = z.object({
    origin: z.string().describe("The site."),
    permissions: z
        .array(z.object({ permission: BrowserPermissionSchema, setting: PermissionSettingSchema }))
        .describe("Every permission this browser answers, with the site's standing answer for each."),
    location: z.boolean().describe("Your location is shared with this window, for the sites allowed it."),
});
export type SitePermissions = z.infer<typeof SitePermissionsSchema>;

export const SetSitePermissionInputSchema = z.object({
    ...WindowParams,
    origin: z.string().describe("The site, as scheme://host[:port]."),
    permission: BrowserPermissionSchema,
    setting: PermissionSettingSchema.describe("Allow, block, or ask again next time."),
    location: GeolocationSchema.optional().describe("Your own location, when allowing a site to know it."),
});

export const BrowserPageToolInputSchema = z.object({
    ...WindowParams,
    pageId: z.string().describe("Which tab."),
});

export const ViewSourceResultSchema = z.object({
    pageId: z.string().optional().describe("The tab the source opened in, once the window lists it."),
});

export const DevToolsResultSchema = z.object({
    path: z
        .string()
        .describe(
            "Where Chromium's own DevTools for the page are served, relative to the sandbox's address: a frame opens it as is. Carries its own ticket, so it works without a header.",
        ),
    socket: z
        .string()
        .describe("The page's DevTools socket, relative to the sandbox's address: what the frontend is told to connect to (its `ws=` or `wss=`)."),
    expiresAt: z.number().describe("When the ticket stops working, in milliseconds."),
});

// A recording of a window's picture under way (browser/media/recordings.ts in the daemon): castd's own H.264 stream
// rewrapped as an MP4, nothing encoded again, listed with the window's downloads once it stops.
export const BrowserRecordingSchema = z.object({
    startedAt: z.number().describe("When it started, in milliseconds."),
    maxSeconds: z.number().describe("The longest it runs: it stops by itself then, and is listed with the downloads all the same."),
});
export type BrowserRecording = z.infer<typeof BrowserRecordingSchema>;

export const BrowserWindowInputSchema = z.object(WindowParams);

export const BrowserUploadQuerySchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u).describe("An id the uploader picks, the same for every part of one file."),
    name: z.string().min(1).max(255).describe("The file's own name, which the page sees."),
});
