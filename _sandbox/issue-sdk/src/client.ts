import type { IssueIngest, IssuePublicConfig, IssueReport } from "@intentic/sandbox-contract";
import { type EmbedEndpoint, solveProofOfWork, storedId } from "@intentic/sandbox-contract/embed";
import { type Breadcrumbs, createBreadcrumbs } from "./breadcrumbs.js";
import { type Capture, reportFrom, startCapture } from "./capture.js";
import { fetchChallenge, fetchConfig, send } from "./transport.js";

// Everything between an error happening and the daemon having it; how it looks is a separate, optional module
// (dialog.ts). Must never break the page it watches: every path swallows its own failures, `report` resolves rather
// than rejects, and the console is used only where a site owner could act.

export interface InitOptions {
    // Which intake to send to; derived from the <script> tag for an embed, or passed to `init` directly.
    readonly automationId: string;
    readonly base: string;
    // The commit this build came from; with it the agent checks out the build, without it it's guessing.
    readonly release?: string;
    // The key an app with no origin presents (phone, desktop, server); an allowed browser origin needs none.
    readonly key?: string;
    // Anything describing the app, not the crash (route, locale, tenant); small strings, bounded by the daemon.
    readonly context?: Record<string, string>;
    // Whether to arm the uncaught-error handlers; absent defers to the intake's own config.
    readonly captureCrashes?: boolean;
    // Return a modified report or `null` to drop it; inside the try, a throw here drops the report, not the page.
    readonly beforeSend?: (report: IssueReport) => IssueReport | null;
}

export interface IssueClient {
    // An error the app caught itself; resolves to the issue's short id, or undefined if dropped or refused.
    readonly captureException: (error: unknown, context?: Record<string, string>) => Promise<string | undefined>;
    // Send what a person wrote; `description` is theirs, everything else is the SDK's.
    readonly report: (input: { description: string; email?: string; name?: string }) => Promise<string | undefined>;
    // Something the app noticed itself; grouped like a crash, so one repeatedly firing is one row with a count.
    readonly detect: (message: string, context?: Record<string, string>) => Promise<string | undefined>;
    // Add a breadcrumb of the app's own: a checkout step, a feature flag flip.
    readonly breadcrumb: (kind: string, message: string) => void;
    // What the daemon says this intake looks like, for a host drawing its own dialog.
    readonly config: IssuePublicConfig;
    // Unhook everything: the error handlers and every global the breadcrumb ring wrapped.
    readonly stop: () => void;
}

// The intake as the daemon resolved it, plus the two handles a page-long client keeps.
export const createClient = async (options: InitOptions): Promise<IssueClient> => {
    const endpoint: EmbedEndpoint = { base: options.base.replace(/\/$/, ""), automationId: options.automationId };
    // Also the reachability probe: an asleep sandbox or bad origin throws here rather than posting into the void.
    const config = await fetchConfig(endpoint);
    // A per-browser id in localStorage, namespaced per intake: the rate-limit key, and what a proof of work binds.
    const clientId = storedId(`intentic.issues.${options.automationId}.client`);
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
                // Only a written report needs a proof, never a crash: a crash handler has no second to spend on it.
                ...(shaped.kind === "report" && config.antiBot === "pow"
                    ? { powNonce: await solveProofOfWork(await fetchChallenge(endpoint, clientId), "This page must be served over HTTPS to send a report.") }
                    : {}),
            };
            return (await send(endpoint, body)).id;
        } catch {
            // Swallowed silently: an offline visitor or asleep sandbox must not be noisy about it.
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
                // A headline the SDK invents; the daemon lists a report by `description`, falling back when that's
                // empty.
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

// Everything the report itself didn't carry: where it happened, the build, breadcrumbs. Added here, not per call site,
// so a caught crash and a hand-reported one arrive identical and can group.
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
