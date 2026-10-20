import { Hono } from "hono";
import { FAVICON_ICO_BASE64 } from "./favicon.generated.js";

// The lotus in the api's blue (_site/site/scripts/backend-icons.mjs), so a tab on this address reads apart from the
// site's and a sandbox's.
const FAVICON = Buffer.from(FAVICON_ICO_BASE64, `base64`);

// The two unauthenticated GETs that are not the platform's business: a liveness probe, and the icon a browser asks for
// by convention when a tab is opened on this address. `ping` is one round trip to the database.
export const probeRoutes = ({ ping }: { readonly ping: () => Promise<void> }) => {
    const app = new Hono();
    app.get(`/health`, async (c) => {
        try {
            await ping();
            return c.json({ status: `ok` });
        } catch (error) {
            return c.json({ status: `error`, message: error instanceof Error ? error.message : `unknown` }, 503);
        }
    });
    app.get(`/favicon.ico`, (c) => c.body(FAVICON, 200, { "Content-Type": `image/x-icon`, "Cache-Control": `public, max-age=604800, immutable` }));
    return app;
};
