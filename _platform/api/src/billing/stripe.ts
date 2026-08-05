import Stripe from "stripe";
import type { Config } from "../config.js";

// Single Stripe client for the platform's own billing (checkout, customer-portal, price lookups) — shared by the
// Better Auth plugin (auth.ts) and the billing router. Memoized: the secret key is fixed per process. Callers
// must ensure config.stripe.secretKey is set — the client throws on an empty key, and billing is off without it.
let client: Stripe | undefined;

export const getStripe = (config: Config): Stripe => {
    if (!client) {
        client = new Stripe(config.stripe.secretKey);
    }
    return client;
};
