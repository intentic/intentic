import { DEFAULT_MODELS, DEFAULT_REPLY, startFakeUpstream } from "./server.ts";

/* The container's entrypoint. Node 24 runs TypeScript by erasing its types, which is why this package has no
 * build step and no dependencies at all: the image is the stock node base with two `.ts` files copied in. That
 * is the whole reason it can be stood up inside a test in a second.
 *
 * Every setting is an environment variable because the only caller is a container start. A fixed port, unlike
 * the library's default of 0, because a container is addressed by name and port from the outside. */

const list = (raw: string | undefined): string[] =>
    (raw ?? ``)
        .split(`,`)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ``);

const models = list(process.env[`FAKE_UPSTREAM_MODELS`]);
const refuseKeys = list(process.env[`FAKE_UPSTREAM_REFUSE_KEYS`]);

const upstream = await startFakeUpstream({
    port: Number(process.env[`PORT`] ?? `8099`),
    models: models.length > 0 ? models : DEFAULT_MODELS,
    reply: process.env[`FAKE_UPSTREAM_REPLY`] ?? DEFAULT_REPLY,
    refuseKeys,
});

// The only line this ever prints, and it is the one a harness greps for to know the port is open.
console.log(`fake-upstream listening on ${upstream.port}`);

for (const signal of [`SIGINT`, `SIGTERM`] as const) {
    process.on(signal, () => {
        void upstream.close().then(() => process.exit(0));
    });
}
