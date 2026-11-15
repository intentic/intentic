import { loopDoor } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { mentionsSpentAllowance } from "../../../engines/failure-sentences.js";
import { readableProviderText } from "../../../engines/provider-error-text.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { ErrorFrame, FailureContext, FailureQueries } from "./classify-failure.js";
import { withClause } from "./frame-clause.js";

/** Whether a turn's requests go through the daemon's translator gateway, which places each one on an account of its own. */
export const routedTurn = (provider: AgentProvider, harness: AgentHarness): boolean =>
    KeyedProviderSchema.safeParse(provider).success && loopDoor(provider, harness) === undefined;

/* A THROTTLE IS AN OUTAGE, NOT A SPENT ALLOWANCE, AND IT IS DECIDED HERE, ONCE, BEFORE ANYTHING READS THE CODE. A routed
   loop reports every 429 as `rate_limit`, and Google's "Resource has been exhausted (e.g. check quota)." is a 429 that
   spends nothing: it is Google slowing the model down, on every account at once (on 2026-11-15 all 31 refused
   gemini-3.8-flash-high within 23 seconds, and the cheap gemini-3.1-flash-lite at two in the morning, while each
   answered a request minutes later on the same weekly reading). The gateway already tells the two apart, reading each
   account's own answer (translator-gateway.ts causeOf), and since 2026-11-14 nothing was filed for a throttle. But the
   code stayed `rate_limit`, whose course is the spent allowance's (failure-codes.ts), so everything else that reads the
   code went on calling it one: the turn was held "behind a spent allowance", booked for the loop's own retry instant,
   re-timed to now by the resume pass because every account could serve it, and offered to the person beside a "Usage
   left" that, rightly, still showed 95% of the Gemini pool. Each of those was patched on its own and the next one
   showed the contradiction again. So the frame is re-coded where the gateway's verdict is read: a routed `rate_limit`
   whose latest refusal the gateway handed back as a throttle, and whose words do not say an allowance is spent, is a
   `provider-outage`, held on the provider's outage breaker (provider-health.ts) and resumed on its backoff under the
   owner's outage answer, with the provider's words and a clause saying no allowance is spent. The loop's retry instant
   goes with it: it was never an allowance's reset. */
const THROTTLED =
    "The provider is rate-limiting this model for now, not refusing an allowance: no account's allowance is spent, so Usage left still shows their room.";

/** The frame a throttle the translator gateway handed back is: an outage, not a spent allowance. Any other frame as it came. */
export const throttleAsOutage = (
    event: ErrorFrame,
    context: Pick<FailureContext, "provider" | "model"> & { readonly turn: Pick<RoutedTurn, "harness"> },
    gateway: FailureQueries["gatewayRefused"],
): ErrorFrame => {
    const model = context.model === "" ? undefined : context.model;
    if (event.code !== "rate_limit" || model === undefined || !routedTurn(context.provider, context.turn.harness)) {
        return event;
    }
    // The provider's own words for a spent allowance outrank what the gateway last saw; the sandbox's own sentence does not.
    if ((event.own !== true && mentionsSpentAllowance(event.message)) || gateway?.(context.provider, model) !== "throttled") {
        return event;
    }
    const { resetsAt: _loopRetry, ...frame } = event;
    return { ...frame, code: "provider-outage", message: withClause(readableProviderText(event.message), THROTTLED) };
};

