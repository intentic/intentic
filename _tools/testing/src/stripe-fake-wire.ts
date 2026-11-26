import { randomBytes } from "node:crypto";
import type { FakeCustomer, FakePrice, FakeSession, FakeSubscription } from "./stripe-fake.js";

// The fake Stripe's request rules and wire shapes, apart from its server (stripe-fake.ts): what an update does to a
// subscription, what a checkout request is refused for, and what a subscription looks like on the wire.

export const id = (prefix: string): string => `${prefix}_${randomBytes(9).toString("hex")}`;

export const PERIOD_DAYS = 30;

/** The `metadata[key]` params of a request, as the object Stripe stores and sends back on its events. */
const metadataOf = (params: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
        Object.entries(params).flatMap(([key, value]): [string, string][] => {
            const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
            return name === undefined ? [] : [[name, value]];
        }),
    );

// Subscription in the basil wire shape (period on the item), as both the API and its events return it; fields like
// `latest_invoice` are absent on purpose, since the client must not need them.
export const wireSubscription = (subscription: FakeSubscription) => ({
    id: subscription.id,
    object: "subscription",
    customer: subscription.customer,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    created: subscription.created,
    items: {
        object: "list",
        data: subscription.items.map((item) => ({
            id: item.id,
            object: "subscription_item",
            price: { id: item.price, object: "price" },
            quantity: item.quantity,
            current_period_start: subscription.current_period_end - PERIOD_DAYS * 86_400,
            current_period_end: subscription.current_period_end,
        })),
    },
});

/* ONE SUBSCRIPTION UPDATE'S ITEM GROUPS AND RENEWAL-DATE END, applied the way Stripe applies them: an `id` addresses an existing item
 * and `deleted` removes it, a bare `price` adds a new one. Answers Stripe's own refusal text, or undefined. */
export const applyItemChanges = (subscription: FakeSubscription, params: Record<string, string>): string | undefined => {
    for (let index = 0; params[`items[${index}][id]`] !== undefined || params[`items[${index}][price]`] !== undefined; index += 1) {
        const itemId = params[`items[${index}][id]`];
        const quantity = params[`items[${index}][quantity]`];
        const counted = quantity !== undefined && /^\d+$/.test(quantity);
        if (itemId === undefined) {
            if (!counted) {
                return `Invalid integer: items[${index}][quantity]`;
            }
            subscription.items.push({ id: id("si"), price: params[`items[${index}][price]`] ?? "", quantity: Number(quantity) });
            continue;
        }
        const existing = subscription.items.find((item) => item.id === itemId);
        if (existing === undefined) {
            return `No such subscription_item: '${itemId}'`;
        }
        if (params[`items[${index}][deleted]`] === "true") {
            subscription.items = subscription.items.filter((item) => item.id !== itemId);
            continue;
        }
        if (!counted) {
            return `Invalid integer: items[${index}][quantity]`;
        }
        existing.quantity = Number(quantity);
    }
    const ending = params["cancel_at_period_end"];
    if (ending !== undefined) {
        subscription.cancel_at_period_end = ending === "true";
    }
    return undefined;
};

// The refusals Stripe makes of a checkout request that the client's encoding must never provoke.
export const checkoutRefusal = (params: Record<string, string>, customers: Map<string, FakeCustomer>, price: FakePrice): string | undefined => {
    if (params["mode"] !== "subscription") {
        return "Invalid mode: the hosted plan is sold in subscription mode";
    }
    if ([params["line_items[0][price]"], params["client_reference_id"], params["success_url"], params["cancel_url"]].includes(undefined)) {
        return "Missing required param: line_items[0][price], client_reference_id, success_url and cancel_url are required";
    }
    const asked = params["line_items[0][price]"];
    if (asked !== price.id) {
        return `No such price: '${asked ?? ""}'`;
    }
    if (!price.active) {
        return "The price specified is inactive. This field only accepts active prices.";
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


/** A checkout session as `POST /v1/checkout/sessions` makes it from a request the refusals above let through. */
export const sessionOf = (params: Record<string, string>, origin: string): FakeSession => {
    const sessionId = id("cs_test");
    // Who pays: an existing customer by id, or a new one by email; Stripe takes exactly one of the two.
    const payer = Object.fromEntries((["customer", "customer_email"] as const).flatMap((key) => (params[key] === undefined ? [] : [[key, params[key]]])));
    return {
        id: sessionId,
        url: `${origin}/checkout/${sessionId}`,
        client_reference_id: params["client_reference_id"] ?? "",
        ...payer,
        price: params["line_items[0][price]"] ?? "",
        quantity: Number(params["line_items[0][quantity]"] ?? "1"),
        success_url: params["success_url"] ?? "",
        cancel_url: params["cancel_url"] ?? "",
        metadata: metadataOf(params),
        status: "open",
    };
};
