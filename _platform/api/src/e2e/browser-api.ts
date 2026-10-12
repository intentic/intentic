// The api as a browser tier meets it (_tools/e2e/signin): the real app and its real Better Auth on the Postgres it is
// given, served over plain http on loopback, with two things stood in for: Google's signing keys, and Resend. A browser
// tier cannot get a token Google signed, so its fake Google signs with a key of its own and hands the public half here,
// and this process answers Google's certs address with it. Nor can it read an inbox, so the mail the platform hands
// Resend is kept here instead and served back at GET /__e2e/mail?to=<address> (the newest to that address), which is how
// an email-code spec reads its code. Every other line of the sign-in (one-tap's verification, the code's check, the
// session cookie, the desktop handoff, the one-time token) is the code production runs.
//
// Config is written out here, not read from the root .env or the dev certificate the way main.ts does: a developer's
// own .env would otherwise point this at their Google client and their database, and their dev cert would turn it into
// https under a cookie name the tier does not expect.
//
// Run with bun, from the tier's global setup: `bun src/e2e/browser-api.ts`, configured by the environment below.

import { GOOGLE_CLIENT_ID } from "@intentic/constants";

// Better Auth fetches Google's JWKS from this exact address (@better-auth/core social-providers/google.ts).
const GOOGLE_CERTS = `https://www.googleapis.com/oauth2/v3/certs`;
// Where mail.ts hands a mail to Resend.
const RESEND_EMAILS = `https://api.resend.com/emails`;
// The harness's own door to the mail it kept, answered before the app sees the request.
const MAIL_DOOR = `/__e2e/mail`;

const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === ``) {
        throw new Error(`browser-api: ${name} is required`);
    }
    return value;
};

const port = Number(required(`API_PORT`));
const jwks = JSON.parse(required(`E2E_GOOGLE_JWKS`)) as { keys: unknown[] };

// Installed before the app is imported, so no module can have kept the real fetch. Google's certs are answered from the
// tier's key; anything else addressed to Google is refused, so a sign-in that quietly reached the real Google fails here
// rather than passing on a network this tier never meant to use.
const mailbox: Array<{ readonly to: string; readonly subject: string; readonly html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === GOOGLE_CERTS) {
            return Response.json(jwks);
        }
        if (url === RESEND_EMAILS) {
            // SAFETY: mail.ts sends this body, a JSON object of strings, and nothing else reaches Resend's address.
            const sent = JSON.parse(String(init?.body)) as { to: string; subject: string; html: string };
            mailbox.push({ to: sent.to.toLowerCase(), subject: sent.subject, html: sent.html });
            return Response.json({ id: `e2e-${mailbox.length}` });
        }
        if (/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com)\//u.test(url)) {
            return new Response(`browser-api: ${url} is not reachable from the sign-in tier`, { status: 502 });
        }
        return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
);

const { configSchema } = await import(`../config.js`);
const { createApp } = await import(`../app.js`);
const { createLogger } = await import(`../logger.js`);
const { createPrisma } = await import(`../prisma.js`);

const apiUrl = `http://localhost:${port}`;
const config = configSchema.parse({
    database: { url: required(`DATABASE_URL`), poolMax: 5 },
    betterAuth: { secret: required(`BETTER_AUTH_SECRET`) },
    // Set, as in production: the handoff row's credentials are stored encrypted and read back through the same path.
    secrets: { key: required(`SECRETS_KEY`) },
    webOrigin: required(`WEB_ORIGIN`),
    // The client id the web build compiles in, so the audience one-tap checks is the one the page asked for.
    google: { clientId: GOOGLE_CLIENT_ID, clientSecret: `` },
    // Configured, so email sign-in runs as in production and its mail reaches the stand-in Resend above.
    email: { apiKey: `e2e`, from: `intentic <e2e@intentic.test>` },
    api: { url: apiUrl, port, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: process.env[`LOG_LEVEL`] ?? `warn`, pretty: `false` },
});

const prisma = createPrisma(config);
const logger = createLogger(config);
const { app } = createApp(config, prisma, logger);

// The newest mail to an address, with the six-digit code read out of it; 404 until one arrived.
const mailFor = (request: Request): Response => {
    const to = (new URL(request.url).searchParams.get(`to`) ?? ``).toLowerCase();
    const mail = mailbox.findLast((kept) => kept.to === to);
    if (mail === undefined) {
        return Response.json({ error: `no mail to ${to}` }, { status: 404 });
    }
    return Response.json({ ...mail, code: /[?&;]code=(\d{6})/u.exec(mail.html)?.[1] ?? null });
};

const server = Bun.serve({
    port,
    hostname: `127.0.0.1`,
    fetch: (request) => (new URL(request.url).pathname === MAIL_DOOR ? mailFor(request) : app.fetch(request)),
});
logger.info({ url: apiUrl }, `browser-api started (the sign-in tier's api)`);

const stop = async (): Promise<void> => {
    await server.stop();
    await prisma.$disconnect();
    process.exit(0);
};
process.on(`SIGTERM`, () => void stop());
process.on(`SIGINT`, () => void stop());
