import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import { type StripeApi, stripeApi } from "./stripe-api.js";

const stripeSchema = z.object({ apiKey: z.string() });
const parse = (inputs: ResolvedInputs): { apiKey: string } => parseInputs(stripeSchema, inputs, "stripe");

// Stripe as a validated external integration (v1: validate-only, non-destructive). `read` confirms the API key
// resolves a live account (treating an unreachable API as not-yet-validated so plan stays forward-moving);
// `diff` is always noop (intentic mutates nothing on Stripe yet); `apply` re-validates and throws on a rejected
// key. The key itself is injected into consuming apps as a $secret env elsewhere — this node only proves it works.
export const createStripeProvider = (api: StripeApi = stripeApi): Provider => ({
    read: async (inputs, ctx) => {
        const { apiKey } = parse(inputs);
        try {
            const account = await api.getAccount(apiKey);
            return account === undefined ? undefined : { outputs: {} };
        } catch (error) {
            ctx.log(`stripe "${ctx.id}": Stripe API not reachable, treating as not-yet-validated: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const { apiKey } = parse(inputs);
        const account = await api.getAccount(apiKey);
        if (account === undefined) {
            throw new Error(`stripe "${ctx.id}": the Stripe API key was rejected. Check STRIPE_API_KEY in your .env.`);
        }
        return {};
    },
});
