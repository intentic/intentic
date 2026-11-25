import { FIRE_DAILY_MAX_DEFAULT, type WebhookSignature } from "@intentic/sandbox-contract/schemas/automations";
import type { Context } from "hono";
import { presentedDoorToken } from "../auth/tokens/door-tokens.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { readBoundedText } from "../http/bounded-body.js";
import { remoteIpOf } from "../http/remote-ip.js";
import { doorAdmission } from "./door-admission.js";
import { fireAutomation } from "./fire/automation-fire.js";
import { PAYLOAD_MAX } from "./fire/run-fire.js";
import { deliveryIdOf, isPingDelivery, redactPayload, verifyWebhookSignature } from "./fire/webhook-signature.js";
import { claimDelivery, deliverySeen } from "./durable/delivery-ledger.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { opt } from "../opt.js";
import type { AutomationRecord } from "./automations-store.js";

// POST /automations/:id/fire wakes an event automation from a webhook, authenticated by the door token (`?token=` or
// `Authorization: Bearer`) and enforced even in loopback, unlike /enroll. The body reaches the guard as
// AUTOMATION_PAYLOAD; the route responds immediately while the agent turn runs detached.
// A trigger with a `signature` also needs the provider's own signature over the body (the token alone no longer
// fires it), and a redelivery of a call it already took answers `duplicate` without waking anything. Every answer that
// accepts a call says what became of it: `queued`, `duplicate`, or `ignored` (a provider's ping). Credential-named keys
// in a JSON body, and the signing secret anywhere in it, are masked before the payload is handed on.

// Arrivals per minute, per automation and caller, before 429; generous for bursts, tight against a loop.
const FIRE_RATE_MAX = 30;

const admission = doorAdmission();

// Refusal message from the first ceiling hit, or undefined if admitted.
const ceilingRefusal = (id: string, dailyMax: number | undefined, ip: string | undefined, now: number): string | undefined => {
    const refused = admission.admit({ rateKey: `${id}:${ip ?? "?"}`, rateMax: FIRE_RATE_MAX, automationId: id, dailyMax: dailyMax ?? FIRE_DAILY_MAX_DEFAULT }, now);
    if (refused === undefined) {
        return undefined;
    }
    return refused === "rate" ? "rate limited" : "this webhook has reached today's limit";
};

// What a signed trigger's signature says of a call: refused, answered without a wake (a ping, a redelivery), or taken
// with the provider's id for it. An unsigned trigger takes every call, as it always did.
type SignedVerdict =
    | { readonly status: 401; readonly error: string }
    | { readonly status: 200; readonly receipt: "ignored" | "duplicate" }
    | { readonly deliveryId?: string; readonly signingSecret?: string };

const checkSignature = async (
    services: Services,
    automation: AutomationRecord,
    signature: WebhookSignature | undefined,
    headers: Headers,
    body: string,
    now: number,
): Promise<SignedVerdict> => {
    if (signature === undefined) {
        return {};
    }
    const signingSecret = await services.sandboxSecrets.get(signature.secret);
    if (signingSecret === undefined || signingSecret === "") {
        services.logger.warn({ automation: automation.id, secret: signature.secret }, "signed webhook refused: its signing secret is not set");
        return { status: 401, error: "unauthorized" };
    }
    const verified = verifyWebhookSignature(signature.scheme, signingSecret, headers, body, now);
    if (!verified.ok) {
        return { status: 401, error: verified.reason };
    }
    if (isPingDelivery(signature.scheme, headers)) {
        return { status: 200, receipt: "ignored" };
    }
    const deliveryId = deliveryIdOf(signature.scheme, headers, body);
    // A redelivery spends nothing from the day: it is answered before the ceilings.
    if (deliveryId !== undefined && (await deliverySeen(services, automation.id, deliveryId, now))) {
        return { status: 200, receipt: "duplicate" };
    }
    return { ...opt("deliveryId", deliveryId), signingSecret };
};

type EventTrigger = Extract<AutomationRecord["trigger"], { readonly kind: "event" }>;

// The door itself: the automation, its token, whether it is on, and the body read within its cap.
const opened = async (
    services: Services,
    c: Context<AppEnv, "/automations/:id/fire">,
): Promise<Response | { readonly automation: AutomationRecord; readonly trigger: EventTrigger; readonly body: string }> => {
    const automation = await services.automations.get(c.req.param("id"));
    if (automation === undefined || automation.trigger.kind !== "event") {
        return c.json({ error: "no event automation with that id" }, 404);
    }
    if (!(await services.doorTokens.verify("automation", automation.id, presentedDoorToken(c.req.raw.headers, c.req.query("token"))))) {
        return c.json({ error: "unauthorized" }, 401);
    }
    if (!automation.enabled) {
        return c.json({ error: "automation disabled" }, 409);
    }
    // Read before the ceilings, counted as it streams: a chunked body declares no length, and reading it whole
    // first is what the limit exists to prevent. An oversized call spends nothing from the day.
    const body = await readBoundedText(c.req.raw, PAYLOAD_MAX);
    if (body.kind === "tooLarge") {
        return c.json({ error: "payload too large" }, 413);
    }
    if (body.kind === "invalid") {
        return c.json({ error: "the body is not UTF-8 text" }, 400);
    }
    return { automation, trigger: automation.trigger, body: body.value };
};

const createAutomationFireRoute =
    (services: Services) =>
    async (c: Context<AppEnv, "/automations/:id/fire">): Promise<Response> => {
        const door = await opened(services, c);
        if (door instanceof Response) {
            return door;
        }
        const { automation, trigger, body } = door;
        const now = Date.now();
        const signed = await checkSignature(services, automation, trigger.signature, c.req.raw.headers, body, now);
        if ("status" in signed) {
            return signed.status === 401 ? c.json({ error: signed.error }, 401) : c.json({ ok: true, receipt: signed.receipt });
        }
        const { deliveryId, signingSecret } = signed;
        const refused = ceilingRefusal(automation.id, trigger.dailyMax, remoteIpOf(c), now);
        if (refused !== undefined) {
            return c.json({ error: refused }, 429);
        }
        // Claimed only once admitted, so a retry of a call the ceilings turned away is still taken; claimed inside one
        // write, so two copies landing together wake once.
        if (deliveryId !== undefined && !(await claimDelivery(services, automation.id, deliveryId, now))) {
            return c.json({ ok: true, receipt: "duplicate" });
        }
        const payload = redactPayload(body, signingSecret);
        // Webhook wakes surface like a Discord mention; origin has no author or channel since the sender is a system.
        void fireAutomation(services, automation, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true, receipt: "queued" });
    };

// An event automation's webhook, on the automation's own token.
export const automationFireRawRoutes = defineRawRoutes((services: Services) => ({ "POST /automations/{id}/fire": createAutomationFireRoute(services) }));
