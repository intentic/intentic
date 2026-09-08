import { embedEndpointOf, embedScript } from "@intentic/sandbox-contract/embed";
import { createClient, type InitOptions, type IssueClient } from "./client.js";
import { openDialog } from "./dialog.js";

// Two ways in, one module so they don't drift:
// - a <script> tag auto-boots from its own attributes; the daemon is the origin the script loaded from, unless
//   data-base overrides it
// - `init(...)` from an import, for a bundler or an app computing its own release
// `window.Intentic` is part of the product: the only way a script-tag install opens the dialog or reports by hand.

export type { InitOptions, IssueClient };

// The live client, if one has started; a second `init` returns the first instead of double-reporting.
let started: Promise<IssueClient> | undefined;

export const init = (options: InitOptions): Promise<IssueClient> => {
    started ??= createClient(options);
    return started;
};

// Awaits the client rather than requiring one, so a link can be wired before the config fetch returns. Silent when no
// client started, since the reporter never coming up is the site's problem, not the visitor's to see.
export const openReportDialog = async (): Promise<void> => {
    const client = await started;
    if (client !== undefined) {
        openDialog(client);
    }
};

// An error the app caught itself, for a Vue errorHandler, a React error boundary, or any catch worth hearing about;
// resolves to the issue's short id, or undefined when nothing was sent.
export const captureException = async (error: unknown, context?: Record<string, string>): Promise<string | undefined> =>
    (await started)?.captureException(error, context);

export const report: IssueClient["report"] = async (input) => (await started)?.report(input);
export const breadcrumb = async (kind: string, message: string): Promise<void> => void (await started)?.breadcrumb(kind, message);

// The <script>-tag entry.

const boot = (script: HTMLScriptElement): void => {
    const endpoint = embedEndpointOf(script);
    if (endpoint === undefined) {
        // Worth a console line: without it the reporter is silently absent with nothing else to go on.
        console.error(`[intentic] the bug reporter embed needs data-automation="<intake id>"`);
        return;
    }
    void init({
        ...endpoint,
        ...(script.dataset["release"] === undefined ? {} : { release: script.dataset["release"] }),
        ...(script.dataset["key"] === undefined ? {} : { key: script.dataset["key"] }),
    }).catch((error: unknown) => {
        // A setup failure, not a lost report (deleted intake, sleeping sandbox, bad origin); the daemon names which.
        console.error(`[intentic] the bug reporter could not start:`, error);
    });
};

// Published before boot so a script running between the two still finds it; only ever added to, never replaced.
const globalTarget = window as unknown as { Intentic?: Record<string, unknown> };
globalTarget.Intentic = { ...globalTarget.Intentic, init, openReportDialog, captureException, report, breadcrumb };

// Read at module scope while the script body executes; absent under a bundler.
const tag = embedScript("/intake/sdk.js");
if (tag !== null) {
    boot(tag);
}
