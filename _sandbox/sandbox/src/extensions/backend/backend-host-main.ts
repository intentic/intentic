import { serve } from "@hono/node-server";
import { extensionApiVersion } from "@intentic/extension-api/protocol";
import { BACKEND_CONFIG_ENV, type BackendDeviceConfig } from "./backend-host-config.js";
import { createBackendHostApp } from "./backend-host.js";

/* The backend host's process entry, spawned and supervised by the daemon (backend-supervisor.ts). */

const raw = process.env[BACKEND_CONFIG_ENV];
if (raw === undefined || raw === "") {
    console.error(`missing ${BACKEND_CONFIG_ENV}: this process is only ever started by the sandbox daemon`);
    process.exit(1);
}
const config = JSON.parse(raw) as BackendDeviceConfig;
// The supervisor injects the version it compiled against rather than trusting the config to stay honest, but
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

// The supervisor ends the host's whole process group with SIGTERM and a grace before SIGKILL (process-group.ts): every
// extension's deactivate gets that grace, all at once and each under its own deadline, so a backend closes what it
// opened rather than having it cut. A second signal while draining is the same request, not a second drain.
let draining = false;
const drain = (): void => {
    if (draining) {
        return;
    }
    draining = true;
    void app.drain().finally(() => process.exit(0));
};
process.on("SIGTERM", drain);
process.on("SIGINT", drain);
