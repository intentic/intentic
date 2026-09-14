import { DEFAULT_MODELS, DEFAULT_REPLY, startFakeUpstream } from "./server.ts";

/* The container's entrypoint. */

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
