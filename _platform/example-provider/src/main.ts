import { createProvider } from "./provider.js";

/* Boot the example provider under Bun. Two env vars:
 *   SERVICE_SECRET, the signing secret the platform answered when the listing was drafted (required).
 *   PORT          , where to listen (default 8790). Put TLS in front (a proxy, a tunnel, a PaaS): the
 *                    listing rules require a public https endpoint, and this process serves plain http. */

const secret = process.env[`SERVICE_SECRET`] ?? ``;
if (secret === ``) {
    console.error(`SERVICE_SECRET is required: it is the signing secret from your draft listing.`);
    process.exit(1);
}

const port = Number(process.env[`PORT`] ?? 8790);
Bun.serve({ port, fetch: createProvider({ secret }).fetch });
console.log(`example provider listening on :${port}: GET /healthz, POST anything signed`);
