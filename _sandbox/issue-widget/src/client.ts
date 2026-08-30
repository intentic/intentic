import type { IssueIngest, IssuePublicConfig, IssueReport } from "@intentic/sandbox-contract";
import { type Breadcrumbs, createBreadcrumbs } from "./breadcrumbs.js";
import { solveProofOfWork } from "./challenge.js";
import { type Capture, reportFrom, startCapture } from "./capture.js";
import { clientIdFor } from "./client-id.js";
import { type Endpoint, fetchChallenge, fetchConfig, send } from "./transport.js";

/* THE SDK ITSELF: everything between "an error happened" and "the daemon has it", and nothing about how it
 * looks (the dialog is a separate module and an optional one).
 *
 * ONE RULE ABOVE ALL OTHERS: this must never be the thing that breaks the page it is watching. A crash reporter
 * that throws inside a crash handler turns one bug into two, one of which nobody can debug because the tool
 * that would have reported it is the tool that failed. So every path here swallows its own failures, `report`
 * resolves rather than rejecting, and the console is written to only where a SITE OWNER could act on it. */

export interface InitOptions {
    /* Which intake to send to. Both are derived for a <script> embed (main.ts reads them off the tag); an app
     * calling `init` directly passes them, and `base` is the sandbox's own origin. */
    readonly automationId: string;
    readonly base: string;
    /* THE COMMIT THIS BUILD CAME FROM. The single most valuable thing a host can set, and the reason there are
     * no sourcemaps in this product: with it the agent checks the build out and reads the real frames; without
     * it, it is guessing which version of the file it is looking at. Wire it to whatever your bundler already
     * knows, a git sha, a tag, a release name. */
    readonly release?: string;
    // The key an app with no website origin presents (a phone, a desktop build, a server). A browser on an
    // allowed origin needs none and should not carry one.
    readonly key?: string;
    // Anything that describes the app rather than the crash: a route name, a locale, a tenant, a build channel.
    // Small strings; the daemon bounds both the count and the length.
    readonly context?: Record<string, string>;
    // Whether to arm the uncaught-error handlers. Absent ⇒ whatever the intake is configured for, which is on.
    readonly captureCrashes?: boolean;
    /* THE LAST WORD ON WHAT LEAVES THE PAGE. Called with every report just before it is sent; return a modified
     * one, or `null` to drop it entirely. This is where a host scrubs an id out of a message, drops crashes from
     * a browser extension, or samples a noisy one. It runs INSIDE the try, so a `beforeSend` that throws drops
     * the report rather than the page. */
    readonly beforeSend?: (report: IssueReport) => IssueReport | null;
}

export interface IssueClient {
    /* Report an error the app caught itself. The one call worth wiring by hand: a Vue `errorHandler`, a React
     * error boundary's `componentDidCatch`, the `catch` in a job runner. Resolves to the issue's short id, or
     * undefined when it was dropped or refused. */
    readonly captureException: (error: unknown, context?: Record<string, string>) => Promise<string | undefined>;
    // Send what a person wrote. `description` is theirs; everything else is the SDK's.
    readonly report: (input: { description: string; email?: string; name?: string }) => Promise<string | undefined>;
    // Something the app noticed itself and thinks is wrong. Grouped like a crash, so a detection firing on every
    // page load is one row with a count.
    readonly detect: (message: string, context?: Record<string, string>) => Promise<string | undefined>;
    // Add a breadcrumb of the app's own: a step in a checkout, a feature flag flipping.
    readonly breadcrumb: (kind: string, message: string) => void;
    // What the daemon says this intake looks like, for a host drawing its own dialog.
    readonly config: IssuePublicConfig;
    // Unhook everything: the error handlers and every global the breadcrumb ring wrapped.
    readonly stop: () => void;
}

// The intake as the daemon resolved it, plus the two handles a page-long client keeps.
export const createClient = async (options: InitOptions): Promise<IssueClient> => {
    const endpoint: Endpoint = { base: options.base.replace(/\/$/, ""), automationId: options.automationId };
    /* The config fetch is also the reachability probe: a sandbox that is asleep, an intake that was deleted, and
     * an origin nobody listed all land here. It THROWS rather than degrading to a default, because a reporter
     * that silently posts into the void is worse than one that says it could not start. main.ts turns that into
     * one console line for the site owner and then stands down. */
    const config = await fetchConfig(endpoint);
    const clientId = clientIdFor(options.automationId);
    const crumbs = createBreadcrumbs();

    const deliver = async (report: IssueReport): Promise<string | undefined> => {
        try {
            const shaped = options.beforeSend === undefined ? report : options.beforeSend(report);
            if (shaped === null) {
                return undefined;
            }
            const body: IssueIngest = {
                report: enrich(shaped, options, crumbs),
                clientId,
                ...(options.key !== undefined ? { key: options.key } : {}),
                // Only a written report is ever asked for a proof, and only when this intake asks. Solving is a
                // second of the reporter's time, which is affordable while they wait on a dialog and is not
                // affordable in a crash handler.
                ...(shaped.kind === "report" && config.antiBot === "pow"
                    ? { powNonce: await solveProofOfWork(await fetchChallenge(endpoint, clientId)) }
                    : {}),
            };
            return (await send(endpoint, body)).id;
        } catch {
            /* Swallowed on purpose and without a console line. This runs on somebody else's product, often
             * inside their crash: an offline visitor, a blocked request, a sandbox that is asleep must all be
             * silent. The failures a site owner can actually fix (a bad id, an origin nobody listed) surface at
             * startup instead, where they are about setup rather than about one lost report. */
            return undefined;
        }
    };

    const capture: Capture | undefined = (options.captureCrashes ?? config.captureCrashes)
        ? startCapture((report) => void deliver(report))
        : undefined;

    return {
        captureException: (error, context) => deliver({ ...reportFrom(error), ...(context === undefined ? {} : { context }) }),
        report: ({ description, email, name }) =>
            deliver({
                kind: "report",
                /* The message is a HEADLINE the SDK makes up, and the description is what they actually wrote.
                 * Both are sent: the daemon lists a written report by the description (it is the thing a person
                 * said) and keeps the message as the fallback for one that arrives empty. */
                message: description.split("\n")[0]?.slice(0, 200) || "A problem was reported",
                description,
                ...(email !== undefined || name !== undefined
                    ? { reporter: { ...(email === undefined ? {} : { email }), ...(name === undefined ? {} : { name }) } }
                    : {}),
            }),
        detect: (message, context) => deliver({ kind: "detection", message, ...(context === undefined ? {} : { context }) }),
        breadcrumb: crumbs.add,
        config,
        stop: () => {
            capture?.detach();
            crumbs.detach();
        },
    };
};

/* Everything the report did not carry: where it happened, which build, what the app said about itself, and what
 * led up to it. Added HERE rather than at each call site so that a crash caught by the handlers and one the app
 * reported by hand arrive identical, which is what lets them group. */
const enrich = (report: IssueReport, options: InitOptions, crumbs: Breadcrumbs): IssueReport => {
    const crumbed = crumbs.all();
    return {
        ...report,
        url: report.url ?? location.href,
        ...(options.release !== undefined ? { release: options.release } : {}),
        userAgent: navigator.userAgent,
        ...(options.context !== undefined || report.context !== undefined
            ? { context: { ...options.context, ...report.context } }
            : {}),
        ...(crumbed.length > 0 ? { breadcrumbs: crumbed } : {}),
    };
};
