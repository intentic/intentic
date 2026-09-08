import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Stand-in for Stripe: the calls the hosted plan makes and the webhooks it listens for, so the money path runs end to
// end with no real account. Not a test of Stripe itself; delivery is injected (`deliver`) so the in-process and browser
// tiers share one seam. Wire shapes follow API 2025-03-31.basil: `current_period_end` lives on the item, not the
// subscription.

export interface FakeStripeOptions {
    /** What `Authorization: Bearer …` must carry. Anything else is refused the way Stripe refuses it. */
    readonly secretKey: string;
    /** The webhook signing secret (whsec_…), what emitted events are signed with. */
    readonly webhookSecret: string;
    /** Where events are delivered. */
    readonly webhookUrl: string;
    /** How an event reaches the webhook. Defaults to `fetch`; the in-process tier passes `app.request`. */
    readonly deliver?: (request: Request) => Promise<Response>;
    /** The clock every `created` and period end is read from. */
    readonly now?: () => Date;
    /** How long the hosted checkout page waits after redirecting before `checkout.session.completed` lands. */
    readonly checkoutWebhookDelayMs?: number;
    /** A fixed port, or 0 (the default) for any free one. */
    readonly port?: number;
}

export interface FakeCustomer {
    readonly id: string;
    readonly email: string;
}

export interface FakeSubscription {
    readonly id: string;
    readonly customer: string;
    status: string;
    cancel_at_period_end: boolean;
    /** Epoch seconds, the item's `current_period_end`. */
    current_period_end: number;
    readonly created: number;
    readonly item: { readonly id: string; readonly price: string; quantity: number };
}

export interface FakeSession {
    readonly id: string;
    readonly url: string;
    readonly client_reference_id: string;
    readonly customer?: string;
    readonly customer_email?: string;
    readonly price: string;
    readonly quantity: number;
    readonly success_url: string;
    readonly cancel_url: string;
    status: "open" | "complete";
    subscription?: string;
}

/** One request the platform made of "Stripe", as the tests assert on it: what was encoded, and with what key. */
export interface FakeCall {
    readonly method: string;
    readonly path: string;
    readonly params: Record<string, string>;
    readonly authorized: boolean;
}

export type FakeSubscriptionPatch = Partial<Pick<FakeSubscription, "status" | "cancel_at_period_end" | "current_period_end">> & {
    readonly quantity?: number;
};

export interface FakeEmitOptions {
    /** The event's own `created`, the ordering guard's input. Defaults to now. */
    readonly createdAt?: Date;
    /** The signature's timestamp. Defaults to now; the replay-window refusal test moves it. */
    readonly at?: Date;
    /** Signs with another secret, for the refusal test. */
    readonly secret?: string;
}

export interface FakeStripe {
    /** The value for `HOSTED_PLAN_STRIPE_API_URL`: `http://127.0.0.1:<port>/v1`. */
    readonly url: string;
    /** The origin the hosted pages (checkout, portal) are served from. */
    readonly origin: string;
    readonly calls: FakeCall[];
    readonly customers: Map<string, FakeCustomer>;
    readonly subscriptions: Map<string, FakeSubscription>;
    readonly sessions: Map<string, FakeSession>;
    /** Complete a checkout the way a buyer paying does: a customer, a live subscription, and the completed event delivered. */
    complete(sessionId: string): Promise<{ subscription: FakeSubscription; delivered: Response }>;
    /** Change a subscription on "Stripe's" side (a cancel in the portal, a failed charge, a renewal) and deliver the event. */
    update(subscriptionId: string, patch: FakeSubscriptionPatch, opts?: FakeEmitOptions): Promise<Response>;
    /** Deliver any event, signed. */
    emit(type: string, object: unknown, opts?: FakeEmitOptions): Promise<Response>;
    close(): Promise<void>;
}

const id = (prefix: string): string => `${prefix}_${randomBytes(9).toString("hex")}`;

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const PERIOD_DAYS = 30;

/** Stripe's signature header over a payload: `t=<seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<payload>")>`. */
export const signStripePayload = (payload: string, secret: string, at: Date): string => {
    const t = seconds(at);
    return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
};

// the wire

// Stripe's own refusal envelope, so the client's error reads "Stripe refused: …" here exactly as it would there.
const refuse = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
};

const json = (res: ServerResponse, body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

const html = (res: ServerResponse, title: string, body: string): void => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`);
};

const redirect = (res: ServerResponse, to: string): void => {
    res.writeHead(303, { location: to });
    res.end();
};

const notFound = (res: ServerResponse, what: string): void => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(what);
};

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const form = (action: string, label: string): string => `<form method="post" action="${action}"><button type="submit">${label}</button></form>`;

// Subscription in the basil wire shape (period on the item), as both the API and its events return it; fields like
// `latest_invoice` are absent on purpose, since the client must not need them.
const wireSubscription = (subscription: FakeSubscription): Record<string, unknown> => ({
    id: subscription.id,
    object: "subscription",
    customer: subscription.customer,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    created: subscription.created,
    items: {
        object: "list",
        data: [
            {
                id: subscription.item.id,
                object: "subscription_item",
                price: { id: subscription.item.price, object: "price" },
                quantity: subscription.item.quantity,
                current_period_start: subscription.current_period_end - PERIOD_DAYS * 86_400,
                current_period_end: subscription.current_period_end,
            },
        ],
    },
});

// The refusals Stripe makes of a checkout request that the client's encoding must never provoke.
const checkoutRefusal = (params: Record<string, string>, customers: Map<string, FakeCustomer>): string | undefined => {
    if (params["mode"] !== "subscription") {
        return "Invalid mode: the hosted plan is sold in subscription mode";
    }
    if ([params["line_items[0][price]"], params["client_reference_id"], params["success_url"], params["cancel_url"]].includes(undefined)) {
        return "Missing required param: line_items[0][price], client_reference_id, success_url and cancel_url are required";
    }
    const customer = params["customer"];
    if (customer !== undefined && params["customer_email"] !== undefined) {
        return "You may only specify one of these parameters: customer, customer_email";
    }
    if (customer !== undefined && !customers.has(customer)) {
        return `No such customer: '${customer}'`;
    }
    return undefined;
};

// the routes

interface Hit {
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
    readonly url: URL;
    readonly match: RegExpExecArray;
    readonly body: string;
}

interface Route {
    readonly method: string;
    readonly pattern: RegExp;
    readonly handle: (hit: Hit) => Promise<void> | void;
}

const dispatch = async (routes: readonly Route[], req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? "GET";
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (match !== null && route.method === method) {
            await route.handle({ req, res, url, match, body: await readBody(req) });
            return;
        }
    }
    notFound(res, `Unrecognized request URL (${method}: ${url.pathname})`);
};

export const startFakeStripe = async (options: FakeStripeOptions): Promise<FakeStripe> => {
    const now = options.now ?? ((): Date => new Date());
    const deliver = options.deliver ?? ((request: Request): Promise<Response> => fetch(request));
    const calls: FakeCall[] = [];
    const customers = new Map<string, FakeCustomer>();
    const subscriptions = new Map<string, FakeSubscription>();
    const sessions = new Map<string, FakeSession>();
    let origin = "";

    const emit: FakeStripe["emit"] = async (type, object, opts = {}) => {
        const payload = JSON.stringify({
            id: id("evt"),
            object: "event",
            api_version: "2025-03-31.basil",
            created: seconds(opts.createdAt ?? now()),
            livemode: false,
            type,
            data: { object },
        });
        return deliver(
            new Request(options.webhookUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    "stripe-signature": signStripePayload(payload, opts.secret ?? options.webhookSecret, opts.at ?? now()),
                },
                body: payload,
            }),
        );
    };

    const customerFor = (session: FakeSession): FakeCustomer => {
        const existing = session.customer === undefined ? undefined : customers.get(session.customer);
        if (existing !== undefined) {
            return existing;
        }
        const customer: FakeCustomer = { id: id("cus"), email: session.customer_email ?? "" };
        customers.set(customer.id, customer);
        return customer;
    };

    const complete: FakeStripe["complete"] = async (sessionId) => {
        const session = sessions.get(sessionId);
        if (session === undefined || session.status === "complete") {
            throw new Error(`fake stripe: no open checkout session ${sessionId}`);
        }
        const customer = customerFor(session);
        const at = seconds(now());
        const subscription: FakeSubscription = {
            id: id("sub"),
            customer: customer.id,
            status: "active",
            cancel_at_period_end: false,
            current_period_end: at + PERIOD_DAYS * 86_400,
            created: at,
            item: { id: id("si"), price: session.price, quantity: session.quantity },
        };
        subscriptions.set(subscription.id, subscription);
        session.status = "complete";
        session.subscription = subscription.id;
        // As Stripe sends it: the session object, its subscription by id, the buyer as client_reference_id.
        const delivered = await emit("checkout.session.completed", {
            id: session.id,
            object: "checkout.session",
            mode: "subscription",
            status: "complete",
            client_reference_id: session.client_reference_id,
            customer: customer.id,
            subscription: subscription.id,
        });
        return { subscription, delivered };
    };

    const update: FakeStripe["update"] = async (subscriptionId, patch, opts = {}) => {
        const subscription = subscriptions.get(subscriptionId);
        if (subscription === undefined) {
            throw new Error(`fake stripe: no subscription ${subscriptionId}`);
        }
        subscription.status = patch.status ?? subscription.status;
        subscription.cancel_at_period_end = patch.cancel_at_period_end ?? subscription.cancel_at_period_end;
        subscription.current_period_end = patch.current_period_end ?? subscription.current_period_end;
        subscription.item.quantity = patch.quantity ?? subscription.item.quantity;
        const type = subscription.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated";
        return emit(type, wireSubscription(subscription), opts);
    };

    const liveSubscriptionOf = (customerId: string): FakeSubscription | undefined =>
        [...subscriptions.values()].find((candidate) => candidate.customer === customerId && candidate.status !== "canceled");

    // The API: every call logged with what it encoded and whether it carried the key, refused without it.
    const api = (handle: (hit: Hit, params: Record<string, string>) => Promise<void> | void): Route["handle"] => (hit) => {
        const params = Object.fromEntries(new URLSearchParams(hit.body));
        const authorized = hit.req.headers.authorization === `Bearer ${options.secretKey}`;
        calls.push({ method: hit.req.method ?? "GET", path: hit.url.pathname.slice("/v1".length), params, authorized });
        if (!authorized) {
            return refuse(hit.res, 401, "Invalid API Key provided: the key sent does not belong to this account");
        }
        return handle(hit, params);
    };

    const subscriptionOf = (hit: Hit): FakeSubscription | undefined => subscriptions.get(decodeURIComponent(hit.match[1] ?? ""));

    const routes: Route[] = [
        {
            method: "POST",
            pattern: /^\/v1\/checkout\/sessions$/,
            handle: api(({ res }, params) => {
                const refusal = checkoutRefusal(params, customers);
                if (refusal !== undefined) {
                    return refuse(res, 400, refusal);
                }
                const sessionId = id("cs_test");
                const session: FakeSession = {
                    id: sessionId,
                    url: `${origin}/checkout/${sessionId}`,
                    client_reference_id: params["client_reference_id"] ?? "",
                    ...(params["customer"] === undefined ? {} : { customer: params["customer"] }),
                    ...(params["customer_email"] === undefined ? {} : { customer_email: params["customer_email"] }),
                    price: params["line_items[0][price]"] ?? "",
                    quantity: Number(params["line_items[0][quantity]"] ?? "1"),
                    success_url: params["success_url"] ?? "",
                    cancel_url: params["cancel_url"] ?? "",
                    status: "open",
                };
                sessions.set(session.id, session);
                json(res, { id: session.id, object: "checkout.session", url: session.url, mode: "subscription", status: "open" });
            }),
        },
        {
            method: "POST",
            pattern: /^\/v1\/billing_portal\/sessions$/,
            handle: api(({ res }, params) => {
                const customer = params["customer"];
                if (customer === undefined || !customers.has(customer)) {
                    return refuse(res, 400, `No such customer: '${customer ?? ""}'`);
                }
                const url = `${origin}/portal/${customer}?return_url=${encodeURIComponent(params["return_url"] ?? "")}`;
                json(res, { id: id("bps"), object: "billing_portal.session", customer, url });
            }),
        },
        {
            method: "GET",
            pattern: /^\/v1\/subscriptions\/([^/]+)$/,
            handle: api((hit) => {
                const subscription = subscriptionOf(hit);
                return subscription === undefined ? refuse(hit.res, 404, `No such subscription: '${hit.match[1]}'`) : json(hit.res, wireSubscription(subscription));
            }),
        },
        {
            method: "DELETE",
            pattern: /^\/v1\/subscriptions\/([^/]+)$/,
            handle: api(async (hit) => {
                const subscription = subscriptionOf(hit);
                if (subscription === undefined) {
                    return refuse(hit.res, 404, `No such subscription: '${hit.match[1]}'`);
                }
                // Stripe cancels at once and tells the webhook later; told first here so a test reads a settled world.
                await update(subscription.id, { status: "canceled" });
                json(hit.res, wireSubscription(subscription));
            }),
        },
        {
            method: "POST",
            pattern: /^\/v1\/subscriptions\/([^/]+)$/,
            handle: api(async (hit, params) => {
                const subscription = subscriptionOf(hit);
                if (subscription === undefined) {
                    return refuse(hit.res, 404, `No such subscription: '${hit.match[1]}'`);
                }
                const quantity = params["items[0][quantity]"];
                if (params["items[0][id]"] !== subscription.item.id) {
                    return refuse(hit.res, 400, `No such subscription_item: '${params["items[0][id]"] ?? ""}'`);
                }
                if (quantity === undefined || !/^\d+$/.test(quantity)) {
                    return refuse(hit.res, 400, "Invalid integer: items[0][quantity]");
                }
                await update(subscription.id, { quantity: Number(quantity) });
                json(hit.res, wireSubscription(subscription));
            }),
        },

        // Hosted checkout page the browser lands on: Pay completes the session (webhook follows the redirect after the
        // configured delay, as in production); Back abandons it.
        {
            method: "GET",
            pattern: /^\/checkout\/([^/]+)$/,
            handle: ({ res, match }) => {
                const session = sessions.get(match[1] ?? "");
                if (session === undefined) {
                    return notFound(res, "no such checkout session");
                }
                html(
                    res,
                    "Fake Stripe checkout",
                    `<h1>Fake Stripe checkout</h1><p>${escapeHtml(session.price)} × ${session.quantity} for ${escapeHtml(session.client_reference_id)}</p>${ 
                        form(`/checkout/${session.id}/pay`, "Pay") 
                        }${form(`/checkout/${session.id}/cancel`, "Back")}`,
                );
            },
        },
        {
            method: "POST",
            pattern: /^\/checkout\/([^/]+)\/(pay|cancel)$/,
            handle: ({ res, match }) => {
                const session = sessions.get(match[1] ?? "");
                if (session === undefined) {
                    return notFound(res, "no such checkout session");
                }
                if (match[2] === "pay") {
                    setTimeout(() => void complete(session.id).catch(() => undefined), options.checkoutWebhookDelayMs ?? 0);
                }
                redirect(res, match[2] === "pay" ? session.success_url : session.cancel_url);
            },
        },

        // Billing portal the browser lands on: cancel at period end (as Stripe's does) or resume the live subscription,
        // or just return.
        {
            method: "GET",
            pattern: /^\/portal\/([^/]+)$/,
            handle: ({ res, url, match }) => {
                const customer = customers.get(match[1] ?? "");
                if (customer === undefined) {
                    return notFound(res, "no such customer");
                }
                const returnUrl = url.searchParams.get("return_url") ?? "/";
                const back = `?return_url=${encodeURIComponent(returnUrl)}`;
                const subscription = liveSubscriptionOf(customer.id);
                const action =
                    subscription === undefined
                        ? `<p>No active subscription.</p>`
                        : form(`/portal/${customer.id}/${subscription.cancel_at_period_end ? "resume" : "cancel"}${back}`, subscription.cancel_at_period_end ? "Resume plan" : "Cancel plan");
                html(res, "Fake Stripe portal", `<h1>Fake Stripe portal</h1><p>${escapeHtml(customer.email)}</p>${action}<p><a href="${escapeHtml(returnUrl)}">Return</a></p>`);
            },
        },
        {
            method: "POST",
            pattern: /^\/portal\/([^/]+)\/(cancel|resume)$/,
            handle: async ({ res, url, match }) => {
                const subscription = liveSubscriptionOf(match[1] ?? "");
                if (subscription === undefined) {
                    return notFound(res, "no active subscription");
                }
                // The portal's cancel: the subscription stays active until the period ends and says so.
                await update(subscription.id, { cancel_at_period_end: match[2] === "cancel" });
                redirect(res, url.searchParams.get("return_url") ?? "/");
            },
        },

        // The test's own door, for a driver in another process (the browser tier's specs).
        {
            method: "GET",
            pattern: /^\/__test\/state$/,
            handle: ({ res }) =>
                json(res, { customers: [...customers.values()], subscriptions: [...subscriptions.values()], sessions: [...sessions.values()], calls }),
        },
        {
            method: "POST",
            pattern: /^\/__test\/update\/([^/]+)$/,
            handle: async ({ res, match, body }) => {
                const asked = JSON.parse(body || "{}") as { patch?: FakeSubscriptionPatch; createdAt?: string };
                const delivered = await update(match[1] ?? "", asked.patch ?? {}, asked.createdAt === undefined ? {} : { createdAt: new Date(asked.createdAt) });
                json(res, { delivered: delivered.status });
            },
        },
        {
            method: "POST",
            pattern: /^\/__test\/emit$/,
            handle: async ({ res, body }) => {
                const asked = JSON.parse(body || "{}") as { type: string; object: unknown };
                const delivered = await emit(asked.type, asked.object);
                json(res, { delivered: delivered.status });
            },
        },
    ];

    const server: Server = createServer((req, res) => {
        dispatch(routes, req, res, new URL(req.url ?? "/", origin)).catch((error: unknown) => {
            json(res, { error: { message: error instanceof Error ? error.message : String(error) } }, 500);
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    return {
        url: `${origin}/v1`,
        origin,
        calls,
        customers,
        subscriptions,
        sessions,
        complete,
        update,
        emit,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
};
