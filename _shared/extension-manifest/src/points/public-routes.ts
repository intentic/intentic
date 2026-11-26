import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// (2026-11-26) A PUBLIC DOOR INTO AN EXTENSION'S BACKEND: a route anyone on the internet may call, with no sign-in, served
// by the daemon at /door/<id>/<path> and handed to the backend's `api.publicRoutes.serve` handler only once the daemon's
// own protections passed it: the body's size, the per-minute window and the day's ceiling, the caller's Origin against an
// automation's allowlist (or that automation's door key in its place), a solved proof-of-work challenge, a Cloudflare
// Turnstile token (2026-11-26) and a provider's signature over the body, each checked against a sandbox secret the
// extension never sees, a redelivery of a call already taken answered without reaching it. Every request through `/x/<id>` stays behind sign-in.

// What the daemon accepts at most, and what a route that names no ceiling of its own gets.
export const PUBLIC_ROUTE_BODY_MAX = 1024 * 1024;
export const PUBLIC_ROUTE_BODY_DEFAULT = 64 * 1024;
export const PUBLIC_ROUTE_RATE_DEFAULT = 30;
export const PUBLIC_ROUTE_RATE_MAX = 600;
export const PUBLIC_ROUTE_DAILY_DEFAULT = 1_000;
export const PUBLIC_ROUTE_DAILY_MAX = 100_000;
// (2026-11-26) A GET-only route's declaration that it counts no day at all.
export const PUBLIC_ROUTE_NO_DAILY_MAX = "none";

export const PUBLIC_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type PublicRouteMethod = (typeof PUBLIC_ROUTE_METHODS)[number];

// The signing schemes the daemon checks itself, each as its provider signs (the automations wire's own list, which the
// daemon's verifier is typed by, so a scheme here it cannot check fails its typecheck).
export const PUBLIC_ROUTE_SIGNATURE_SCHEMES = ["github", "linear", "sentry", "stripe", "standard-webhooks"] as const;

// (2026-11-26) The header a caller sends a Cloudflare Turnstile token in, for a route declaring `turnstile`: the core's own
// Visitor chat's check, verified by the daemon with a secret the extension never sees.
export const PUBLIC_ROUTE_TURNSTILE_HEADER = "x-intentic-turnstile";

// A segment of a public route's path: a lowercase word (dots allowed, never leading, so no `.` or `..`), or a lone `*`
// standing for any one segment.
const SEGMENT = /^(?:\*|[a-z0-9][a-z0-9._-]{0,63})$/u;
const SEGMENTS_MAX = 8;

// Why a declared path is not one, or undefined when it is.
export const publicRoutePathProblem = (path: string): string | undefined => {
    const segments = path.split("/");
    if (path === "" || segments.length > SEGMENTS_MAX) {
        return `a public route's path is 1 to ${SEGMENTS_MAX} segments joined by "/", with no leading slash`;
    }
    const bad = segments.find((segment) => !SEGMENT.test(segment));
    return bad === undefined ? undefined : `"${bad}" is not a segment: a lowercase word (letters, digits, ".", "_", "-"), or a lone "*" for any one segment`;
};

export const PublicRouteContributionSchema = z
    .object({
        path: z
            .string()
            .superRefine((path, ctx) => {
                const problem = publicRoutePathProblem(path);
                if (problem !== undefined) {
                    ctx.addIssue({ code: "custom", message: problem });
                }
            })
            .describe('Where it answers, under /door/<id>/: segments joined by "/", each a lowercase word or a lone `*` for any one segment, e.g. "hook", "*/report".'),
        methods: z.array(z.enum(PUBLIC_ROUTE_METHODS)).min(1).describe("The methods it answers; anything else is refused before your backend hears of it."),
        automation: z
            .literal(true)
            .optional()
            .describe(
                "The path's first `*` names an automation listening on this extension's own listener provider: one that is not there answers 404 and one switched off 409, its `allowedOrigins` are the list `origins` checks, its door key is what `key` admits, and the day's ceiling is counted per automation.",
            ),
        origins: z
            .enum(["listed", "any"])
            .optional()
            .describe(
                "`listed`: a browser's Origin must be on the automation's allowed origins, or the call is refused (403); needs `automation`. `any` or absent: no Origin is checked, as for a provider's webhook.",
            ),
        key: z
            .literal(true)
            .optional()
            .describe(
                "A caller with no Origin to check (an app, a server) may present the automation's door key instead, as `?key=` or `Authorization: Bearer`; needs `automation` and `origins: \"listed\"`. The key itself never reaches your backend.",
            ),
        keyFromBrowsers: z
            .literal(true)
            .optional()
            .describe(
                "(2026-11-26) An automation that opts in (its trigger's `keyFromBrowsers`) lets its door key admit a browser whose Origin is not on its list too; needs `key`. The owner opts each automation in, off by default, since a key in a public page is anyone's to copy: the minute's window and the day's ceiling are then what bound it.",
            ),
        signature: z
            .object({
                scheme: z.enum(PUBLIC_ROUTE_SIGNATURE_SCHEMES).describe("Which provider's signing scheme the sender uses."),
                secret: z
                    .string()
                    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
                    .describe("The name of the sandbox secret holding the signing secret, which the owner sets; its value never reaches your backend."),
            })
            .optional()
            .describe(
                "Refuse anything not signed by the sender with the named secret (and, for a timestamped scheme, sent within five minutes); a redelivery of a call already taken is answered without reaching your backend.",
            ),
        turnstile: z
            .object({
                secret: z
                    .string()
                    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
                    .describe("The name of the sandbox secret holding the Cloudflare Turnstile secret key, which the owner sets; its value never reaches your backend."),
            })
            .optional()
            .describe(
                `Refuse a call without a Cloudflare Turnstile token the sandbox verifies with Cloudflare under the named secret: the page renders the widget with its site key (public, yours to serve) and sends the token it gets as \`${PUBLIC_ROUTE_TURNSTILE_HEADER}\`. A token is good once.`,
            ),
        proofOfWork: z
            .literal(true)
            .optional()
            .describe(
                "Refuse a call without a solved challenge: the caller fetches one at GET /door/<id>/~challenge?caller=<its id> and sends `x-intentic-pow: <salt>:<nonce>` and `x-intentic-pow-caller: <its id>`.",
            ),
        rate: z
            .number()
            .int()
            .min(1)
            .max(PUBLIC_ROUTE_RATE_MAX)
            .optional()
            .describe(`Calls a minute one caller (by address) may make before 429; ${PUBLIC_ROUTE_RATE_DEFAULT} when absent.`),
        dailyMax: z
            .union([z.number().int().min(1).max(PUBLIC_ROUTE_DAILY_MAX), z.literal(PUBLIC_ROUTE_NO_DAILY_MAX)])
            .optional()
            .describe(
                `Calls a day it takes in all (per automation, for an automation's route) before 429; ${PUBLIC_ROUTE_DAILY_DEFAULT} when absent. \`"none"\` (2026-11-26) counts no day at all, for a route that only serves what a page loads (a script, its settings), so a busy site's page views cannot shut it; only a GET-only route may say it, and its minute's window and size still hold.`,
            ),
        bodyMax: z
            .number()
            .int()
            .min(0)
            .max(PUBLIC_ROUTE_BODY_MAX)
            .optional()
            .describe(`The largest body it takes, in bytes; ${PUBLIC_ROUTE_BODY_DEFAULT} when absent, at most ${PUBLIC_ROUTE_BODY_MAX}.`),
    })
    .superRefine((route, ctx) => {
        if (route.origins === "listed" && route.automation !== true) {
            ctx.addIssue({ code: "custom", path: ["origins"], message: "`origins: \"listed\"` checks an automation's allowed origins, so it needs `automation: true`" });
        }
        if (route.key === true && route.origins !== "listed") {
            ctx.addIssue({ code: "custom", path: ["key"], message: "`key` admits a caller in place of a listed Origin, so it needs `origins: \"listed\"`" });
        }
        if (route.keyFromBrowsers === true && route.key !== true) {
            ctx.addIssue({ code: "custom", path: ["keyFromBrowsers"], message: "`keyFromBrowsers` lets the key stand in for an unlisted browser, so it needs `key: true`" });
        }
        if (route.dailyMax === PUBLIC_ROUTE_NO_DAILY_MAX && route.methods.some((method) => method !== "GET")) {
            ctx.addIssue({ code: "custom", path: ["dailyMax"], message: '`dailyMax: "none"` is for a route that only serves what a page loads, so its methods must be GET alone' });
        }
        if (route.automation === true && !route.path.split("/").includes("*")) {
            ctx.addIssue({ code: "custom", path: ["automation"], message: "`automation` reads the automation's id from the path's first `*`, which this path has none of" });
        }
    })
    .meta({
        power: {
            key: "public:${path}",
            sentence: "anyone on the internet can call its backend at ${methods|, } /${path}${signature? when signed with your secret ${signature.secret}:}",
        },
    });
export type PublicRouteContribution = z.infer<typeof PublicRouteContributionSchema>;

/** The declared route `method` and the path's `segments` (under /door/<id>/) land on, the first that matches; undefined for none. */
export const publicRouteFor = <Route extends Pick<PublicRouteContribution, "path" | "methods">>(
    routes: readonly Route[],
    method: string,
    segments: readonly string[],
): Route | undefined =>
    routes.find((route) => {
        const declared = route.path.split("/");
        return (
            route.methods.some((each) => each === method.toUpperCase()) &&
            declared.length === segments.length &&
            declared.every((glob, index) => {
                const segment = segments[index] ?? "";
                return glob === "*" ? segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\") : glob === segment;
            })
        );
    });

/** The segment of `segments` an automation-scoped route reads the automation's id from: the one under its first `*`. */
export const publicRouteAutomationOf = (route: Pick<PublicRouteContribution, "path" | "automation">, segments: readonly string[]): string | undefined =>
    route.automation === true ? segments[route.path.split("/").indexOf("*")] : undefined;

export const publicRoutesPoint = {
    name: "publicRoutes",
    description:
        "Routes anyone on the internet may call without signing in, served at /door/<id>/<path> and handed to your backend's `api.publicRoutes.serve` handler only after the sandbox's own protections passed the call: its size, a per-minute window and a daily ceiling, an automation's allowed origins or its door key, a proof-of-work challenge, a Cloudflare Turnstile token, a provider's signature, the last two checked against secrets you never see. Each is a power the owner approves.",
    schema: z
        .array(PublicRouteContributionSchema)
        .refine((routes) => new Set(routes.map((route) => route.path)).size === routes.length, { message: "public route paths must be unique" }),
} as const satisfies ContributionPoint;
