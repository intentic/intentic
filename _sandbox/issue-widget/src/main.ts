import { createClient, type InitOptions, type IssueClient } from "./client.js";
import { openDialog } from "./dialog.js";

/* THE ENTRY, WHICH IS TWO ENTRIES.
 *
 *   a <script> tag   auto-boots from its own attributes, and everything is derived:
 *
 *     <script src="https://sandbox-<id>.<zone>/intake/sdk.js"
 *             data-automation="bugs" data-release="a1b2c3d" defer></script>
 *
 *     The daemon to talk to is the ORIGIN THIS SCRIPT CAME FROM, the one thing a copy-pasted snippet cannot get
 *     wrong. `data-base` overrides it for a site fronting the sandbox behind its own proxy, the only case where
 *     the two legitimately differ.
 *
 *   an import        `init(...)` explicitly, for a bundler, a mobile web build, or an app that wants to pass a
 *                    release it computes itself.
 *
 * ONE MODULE FOR BOTH, because the alternative is two entry points that drift: the auto-boot is skipped when
 * there is no tag to read, and that is the whole of the difference.
 *
 * THE GLOBAL IS PART OF THE PRODUCT. A script-tag install has no import to call, so `window.Intentic` is how a
 * site's own "report a problem" link opens the dialog, and how their error boundary reports by hand. */

export type { InitOptions, IssueClient };

// The live client, if one has started. A page has exactly one: two would double-report every crash, and the
// second `init` returning the first is a kinder answer than an error inside somebody's bootstrap.
let started: Promise<IssueClient> | undefined;

export const init = (options: InitOptions): Promise<IssueClient> => {
    started ??= createClient(options);
    return started;
};

/* Open the report dialog. Awaits the client rather than requiring one, so a site can wire this to a link that
 * a person might click before the config fetch has come back, which on a slow connection is most of them.
 *
 * Silent when no client has started: the link was clicked on a page where the reporter never came up (an
 * origin nobody listed, a sleeping sandbox), and a modal saying so would be showing a visitor somebody else's
 * configuration problem. */
export const openReportDialog = async (): Promise<void> => {
    const client = await started;
    if (client !== undefined) {
        openDialog(client);
    }
};

// Report an error the app caught itself. The call to wire into a Vue `errorHandler`, a React error boundary, or
// any `catch` worth hearing about. Resolves to the issue's short id, or undefined when nothing was sent.
export const captureException = async (error: unknown, context?: Record<string, string>): Promise<string | undefined> =>
    (await started)?.captureException(error, context);

export const report: IssueClient["report"] = async (input) => (await started)?.report(input);
export const breadcrumb = async (kind: string, message: string): Promise<void> => void (await started)?.breadcrumb(kind, message);

/* ---- the <script> half ---- */

// `document.currentScript` is only valid while the script body is executing, so it is read at module scope
// rather than inside the async boot. The querySelector is the fallback for a bundler or tag manager that
// re-executes this where currentScript is null.
const ownScript = (): HTMLScriptElement | null =>
    (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>(`script[src*="/intake/sdk.js"]`);

const boot = (script: HTMLScriptElement): void => {
    const automationId = script.dataset["automation"];
    if (automationId === undefined || automationId === "") {
        // The one mistake worth a console line. Without it the reporter is silently absent and the site owner
        // has nothing at all to go on; every other failure is visible in the install panel instead.
        console.error(`[intentic] the bug reporter embed needs data-automation="<intake id>"`);
        return;
    }
    const base = script.dataset["base"] ?? new URL(script.src, window.location.href).origin;
    void init({
        automationId,
        base,
        ...(script.dataset["release"] === undefined ? {} : { release: script.dataset["release"] }),
        ...(script.dataset["key"] === undefined ? {} : { key: script.dataset["key"] }),
    }).catch((error: unknown) => {
        /* A setup failure, not a lost report: a deleted intake, a sleeping sandbox, or (the common one) an
         * origin nobody put on the list. Worth the console line because a site owner is the only person who can
         * fix any of them, and the daemon's own sentence names which. */
        console.error(`[intentic] the bug reporter could not start:`, error);
    });
};

/* Publishing the global BEFORE the boot, so a page whose own script runs between the two still finds the API.
 * Only ever added to: a site with two of our scripts on it (a Front Desk and a reporter) must not have one wipe
 * the other's namespace. */
const globalTarget = window as unknown as { Intentic?: Record<string, unknown> };
globalTarget.Intentic = { ...globalTarget.Intentic, init, openReportDialog, captureException, report, breadcrumb };

const tag = ownScript();
if (tag !== null) {
    boot(tag);
}
