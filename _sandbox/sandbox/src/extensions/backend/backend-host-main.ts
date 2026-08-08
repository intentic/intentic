import { serve } from "@hono/node-server";
import { extensionApiVersion } from "@intentic/extension-api";
import { BACKEND_CONFIG_ENV, type BackendHostConfig } from "./backend-host-config.js";
import { createBackendHostApp } from "./backend-host.js";

/* The backend host's process entry — spawned and supervised by the daemon (backend-supervisor.ts). Everything
 * of substance lives in backend-host.ts; this file only decodes the config, binds loopback, and prints the
 * ready line the supervisor waits for. It dies freely: a throw here (bad config, port taken) is an exit the
 * supervisor reads and reports, never something to recover in-process. */

const raw = process.env[BACKEND_CONFIG_ENV];
if (raw === undefined || raw === "") {
    console.error(`missing ${BACKEND_CONFIG_ENV} — this process is only ever started by the sandbox daemon`);
    process.exit(1);
}
const config = JSON.parse(raw) as BackendHostConfig;
// The supervisor injects the version it compiled against rather than trusting the config to stay honest — but
// a mismatch here would mean two builds in one dist, so it is asserted, not handled.
if (config.apiVersion !== extensionApiVersion) {
    console.error(`config apiVersion ${config.apiVersion} does not match this build (${extensionApiVersion})`);
    process.exit(1);
}

const app = await createBackendHostApp(config);
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, () => {
    // The line the supervisor's readiness wait reads. Everything else on stdout is forwarded into the daemon
    // log as-is (extension log lines carry their own [id] prefix).
    console.log(`backend host listening on ${config.port}`);
});
