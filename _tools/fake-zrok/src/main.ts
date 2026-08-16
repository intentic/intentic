import { DEFAULT_ADMIN_TOKEN, startFakeZrok } from "./server.ts";

/* The container's entrypoint. Node 24 runs TypeScript by erasing its types, which is why this package has no
 * build step and no dependencies: the image is the stock node base with two `.ts` files copied in.
 *
 * A fixed port, unlike the library's default of 0, because a container is addressed by name and port from the
 * outside. */

const zrok = await startFakeZrok({
    port: Number(process.env[`PORT`] ?? `8098`),
    adminToken: process.env[`FAKE_ZROK_ADMIN_TOKEN`] ?? DEFAULT_ADMIN_TOKEN,
});

// The only line this ever prints, and it is the one a harness greps for to know the port is open.
console.log(`fake-zrok listening on ${zrok.port}`);

for (const signal of [`SIGINT`, `SIGTERM`] as const) {
    process.on(signal, () => {
        void zrok.close().then(() => process.exit(0));
    });
}
