import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { fileServiceWant, readServiceCatalog, WANT_MAX, WANT_MIN, WANTS_PER_DAY } from "../pool/pool-catalog.js";
import { refusalResponse, runMeteredService } from "../pool/pool-run.js";
import { consumeGrant, createOffer, findRecentOffer, WHY_MAX } from "./mcp-offer.js";

/* THE THREE TOOLS A CLAUDE CODE SESSION SEES — the sandbox `services` CLI, spoken as MCP.
 *
 * The surface is deliberately the same three verbs (list, run, wanted) carrying the same etiquette, because
 * what is being ported is a *contract with the owner*, not a feature: an agent may ask, the platform states
 * the price, the owner releases the spend, a service that does not answer refunds. Everything below is that
 * contract with a different transport under it.
 *
 * WHAT CHANGED IN THE PORT, and why each had to:
 *
 *   The card became a page. A sandbox has a live conversation to push an offer card into and a held socket to
 *   wait on. A Claude Code session has neither, so `services_run` answers with a URL-mode elicitation — the
 *   spec's own mode for interactions that must not pass through the client or the model — and the approving
 *   happens on the platform's own page, in the owner's browser, under their own session.
 *
 *   The wait became a retry. URL elicitation is multi-round-trip: the client re-calls the tool once the user
 *   is done. Nothing about that retry is trusted — see mcp-offer.ts. The client reporting "they consented" is
 *   not consent; the run re-reads the row the owner's browser wrote.
 *
 *   Progress became notifications. The daemon turns a provider's `status` lines into transcript frames under
 *   the card; here they become `notifications/progress` against the caller's own token, which is what Claude
 *   Code renders while a tool call is in flight.
 *
 * WHAT DID NOT CHANGE is every number. The price, the meter and the refusals are read from the platform's own
 * catalog and relayed in the platform's own words — never composed here, and never shown to the owner by
 * anything but the platform. */

export interface ToolDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly fetchFn: typeof fetch;
    readonly now: () => Date;
    // The demo service's in-process dispatch (see pool-run.ts). Supplied by the mount, which holds the app.
    readonly demoDispatch?: typeof fetch | undefined;
    readonly warn?: ((message: string, service: string) => void) | undefined;
}

/* The slice of the SDK's per-request `extra` this file uses. Named rather than imported whole because the two
 * members below are the entire contract with the transport, and stating them is what lets the tests drive a
 * run without standing up a protocol. */
interface ProgressSink {
    readonly _meta?: { readonly progressToken?: string | number | undefined } | undefined;
    readonly sendNotification: (notification: {
        readonly method: `notifications/progress`;
        readonly params: { readonly progressToken: string | number; readonly progress: number; readonly message?: string };
    }) => Promise<void>;
}

// One text answer, which is what a model reads. `isError` marks the ones it must act on rather than relay.
const say = (text: string, isError = false) => ({ content: [{ type: `text` as const, text }], isError });

/* The request body, canonicalised — this is the key a retry finds its own offer by (mcp-offer.ts
 * findRecentOffer), so it has to be stable for the same logical body. An object is stringified; a string is
 * re-stringified through a parse, so whitespace the model happened to emit does not fork the key and strand
 * an approval nobody can spend. */
export const canonicalRequest = (request: unknown): string => {
    if (typeof request === `string`) {
        try {
            return JSON.stringify(JSON.parse(request));
        } catch {
            return request;
        }
    }
    return JSON.stringify(request ?? {});
};

// A listing, rendered for a model: price, publisher, what it does, and the provider's own worked example —
// which is the best thing to shape a request body after.
const renderListing = (listing: {
    readonly slug: string;
    readonly name: string;
    readonly publisher: string;
    readonly description: string;
    readonly creditsPerRun: number;
    readonly probation: boolean;
    readonly sampleRequest: string;
}): string =>
    [
        `${listing.slug} — ${listing.name} (${listing.publisher})${listing.probation ? ` [new]` : ``}`,
        `  ${listing.description}`,
        `  ${listing.creditsPerRun} credits per run`,
        listing.sampleRequest !== `{}` ? `  example request: ${listing.sampleRequest}` : undefined,
    ]
        .filter((line): line is string => line !== undefined)
        .join(`\n`);

/* THE RUN ITSELF, reached only once a grant has actually been spent. Everything about the money belongs to
 * pool-run.ts — the same function the sandbox's HTTP route drives — so the two surfaces cannot come to
 * different conclusions about what was charged. This owns only how the outcome reads. */
const executeRun = async (deps: ToolDeps, ownerId: string, slug: string, body: string, sink: ProgressSink) => {
    const run = await runMeteredService(
        { config: deps.config, prisma: deps.prisma, fetchFn: deps.fetchFn, now: deps.now, demoDispatch: deps.demoDispatch, warn: deps.warn },
        { ownerId, slug, body },
    );
    if (run.kind === `refused`) {
        const { json } = refusalResponse(run.refusal);
        const error = (json as { error?: { message?: string } | string }).error;
        return say(typeof error === `string` ? error : (error?.message ?? `That run was refused — nothing was charged.`), true);
    }
    if (run.kind === `failed`) {
        return say(`${run.service.name} did not answer — nothing was charged. Please try again shortly.`, true);
    }
    if (run.kind === `answered`) {
        // A provider's own 4xx: a complete answer, CHARGED, relayed verbatim — "your query was malformed" is
        // the service serving exactly what was asked.
        return say(`${run.service.name} refused the request (charged, ${run.remaining} credits left today):\n${run.body}`, true);
    }
    /* The stream. Status lines become progress notifications the moment they arrive — the caller watches the
     * run live rather than a spinner of unknowable length — and the result is buffered into the one answer a
     * model acts on. The receipt goes on the end, in the platform's numbers. */
    // `_meta` is MCP's own field name on a request's extra; renaming it would only hide which wire field it is.
    // eslint-disable-next-line no-underscore-dangle
    const token = sink._meta?.progressToken;
    let result: string | undefined;
    let served = false;
    let progress = 0;
    try {
        while (true) {
            const next = await run.events.next();
            if (next.done) {
                served = next.value;
                break;
            }
            if (next.value.event === `status`) {
                progress += 1;
                if (token !== undefined) {
                    await sink
                        .sendNotification({
                            method: `notifications/progress`,
                            params: { progressToken: token, progress, message: next.value.text },
                        })
                        .catch(() => undefined);
                }
            } else if (next.value.event === `result`) {
                result = JSON.stringify(next.value.data);
            }
        }
    } catch {
        served = false;
    }
    // Always settled, even on a throw: not settling would leave a charge with no ledger entry.
    await run.settle(served);
    if (!served || result === undefined) {
        return say(`${run.service.name} did not finish its answer — nothing was charged. Please try again shortly.`, true);
    }
    return say(`${result}\n\n— charged ${run.credits} credits, ${run.remaining} left today.`);
};

export const registerServiceTools = (server: McpServer, deps: ToolDeps, ownerId: string): void => {
    const { config, prisma } = deps;

    server.registerTool(
        `services_list`,
        {
            title: `List premium services`,
            description:
                `What the intentic services catalog lists, what each run costs in membership credits, and how many are ` +
                `left today. Free to call, spends nothing. Read this before services_run — the slug, the price and the ` +
                `provider's own example request all come from here.`,
            inputSchema: {},
        },
        async () => {
            const catalog = await readServiceCatalog(prisma, config, ownerId, deps.now());
            if (catalog.services.length === 0) {
                return say(
                    `No premium services are listed on this platform yet. Carry on with your ordinary tools — and if a paid ` +
                        `service plausibly could have answered, file one line with services_wanted so providers can see the demand.`,
                );
            }
            const listings = catalog.services.map(renderListing).join(`\n\n`);
            const meter =
                catalog.credits !== undefined
                    ? `${catalog.credits.remaining} of ${catalog.credits.allowance} credits left today (resets ${catalog.credits.resetsAt}).`
                    : `Running any of these needs an intentic membership. Ask for one with services_run and it will offer the join page.`;
            return say(`${listings}\n\n${meter}`);
        },
    );

    server.registerTool(
        `services_run`,
        {
            title: `Run a premium service`,
            description:
                `Ask to run one metered service from the catalog. This does NOT spend on your say-so: the owner gets a link ` +
                `to an approval page showing the price, what will be sent, and today's balance, and only their click there ` +
                `releases the run. One approval covers exactly one run. A service that fails to answer is refunded.`,
            inputSchema: {
                slug: z.string().describe(`The service's slug, exactly as services_list gave it.`),
                request: z.unknown().describe(`The provider's request body as JSON. Shape it after the example in services_list.`),
                why: z.string().max(WHY_MAX).optional().describe(`One line on why this run helps the task. The owner reads it on the approval page.`),
            },
        },
        async ({ slug, request, why }, extra) => {
            const at = deps.now();
            const catalog = await readServiceCatalog(prisma, config, ownerId, at);
            const listing = catalog.services.find((entry) => entry.slug === slug);
            if (listing === undefined) {
                return say(`No service is listed as "${slug}" — services_list names what exists.`, true);
            }
            /* THE MEMBERSHIP DOOR, answered before any card goes up. A non-member's approval page could only
             * offer a button that does not work, so the useful thing to put in front of them is the join page
             * itself. URL mode is also the only honest way to carry somebody to a payment form: the spec
             * forbids asking for payment details through the client, and here the whole interaction stays
             * between the owner and the site — neither this server nor the model sees any of it. */
            if (!catalog.member) {
                throw new UrlElicitationRequiredError([
                    {
                        mode: `url`,
                        message:
                            `Running ${listing.name} needs an intentic membership (${listing.creditsPerRun} credits per run). ` +
                            `Open this to join — no sandbox and no install needed.`,
                        url: `${config.webOrigin}/join`,
                        elicitationId: randomUUID(),
                    },
                ]);
            }
            const service = await prisma.service.findUnique({ where: { slug }, select: { id: true } });
            if (service === null) {
                return say(`No service is listed as "${slug}" — services_list names what exists.`, true);
            }
            const body = canonicalRequest(request);
            const recent = await findRecentOffer(prisma, { userId: ownerId, serviceId: service.id, request: body }, at);
            /* Settled and recent: say what the owner decided, once, and stop. Never re-offer from here — a card
             * that reappears the instant it is dismissed is a nag, and the point of the gate is that "no" is an
             * answer the agent acts on rather than works around. */
            if (recent?.status === `declined`) {
                return say(`The owner skipped this run — nothing was charged. Continue without the service.`, true);
            }
            if (recent?.status === `expired` || (recent?.status === `pending` && recent.expiresAt <= at)) {
                return say(
                    `The approval went unanswered and expired — nothing was charged. Continue without the service; ` +
                        `ask again only if the owner comes back to it.`,
                    true,
                );
            }
            // Still up: hand back the SAME link rather than raising a second card for one question.
            if (recent?.status === `pending`) {
                throw new UrlElicitationRequiredError([
                    {
                        mode: `url`,
                        message: `Waiting on approval for ${listing.name} (${listing.creditsPerRun} credits). Open this to approve or skip it.`,
                        url: `${config.webOrigin}/approve/${recent.id}`,
                        elicitationId: recent.id,
                    },
                ]);
            }
            if (recent?.status === `approved`) {
                const grant = await consumeGrant(prisma, recent.id, ownerId, at);
                if (grant.kind !== `granted`) {
                    // Raced by another retry, or settled out from under us between the read and the claim.
                    return say(`That approval has already been used. One approval covers one run; ask again to run it once more.`, true);
                }
                return await executeRun(deps, ownerId, grant.slug, grant.request, extra);
            }
            /* Nothing recent: raise the card. The row is written FIRST, with the price stamped on it, so the
             * page the owner opens quotes the platform rather than anything the model typed — and so a listing
             * repriced while they are deciding cannot change what they agreed to. */
            const offerId = await createOffer(
                prisma,
                { userId: ownerId, serviceId: service.id, credits: listing.creditsPerRun, request: body, why },
                at,
            );
            throw new UrlElicitationRequiredError([
                {
                    mode: `url`,
                    message:
                        `${listing.name} costs ${listing.creditsPerRun} credits per run. Open this to see what will be sent, ` +
                        `then approve or skip it — nothing is charged until you do.`,
                    url: `${config.webOrigin}/approve/${offerId}`,
                    elicitationId: offerId,
                },
            ]);
        },
    );

    /* The wanted list. Registered beside the two above but sharing nothing with them: it spends nothing, raises
     * no card, needs no membership, and returns nothing about anyone. It is the platform's single most valuable
     * demand signal and its cheapest — an agent that read the catalog and found nothing is telling providers
     * exactly what to build. */
    server.registerTool(
        `services_wanted`,
        {
            title: `File a capability the catalog lacks`,
            description:
                `The catalog had nothing that answered — say what you looked for, in one plain line. Spends nothing, asks ` +
                `nobody, published only as an aggregate count so providers can see unmet demand. Describe the CAPABILITY ` +
                `("flight price lookups with dates"), never the task's specifics, names, or anything personal.`,
            inputSchema: {
                text: z.string().min(WANT_MIN).max(WANT_MAX).describe(`One line naming the capability you could not find.`),
            },
        },
        async ({ text }) => {
            const filed = await fileServiceWant(prisma, ownerId, text, deps.now());
            if (filed.kind === `malformed`) {
                return say(`A want is one plain line describing the capability, ${WANT_MIN}–${WANT_MAX} characters.`, true);
            }
            if (filed.kind === `rate_limited`) {
                return say(`That's ${WANTS_PER_DAY} wants filed today — the daily bound. The list resets at UTC midnight.`, true);
            }
            return say(`Filed. Carry on with your ordinary tools.`);
        },
    );
};
