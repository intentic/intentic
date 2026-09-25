import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { DocsState } from "../contract.js";
import type { ContainerState, DockerEngine } from "./docker.js";

// The document server as one container in the sandbox's Docker engine: pulled and created on the owner's one explicit
// start, brought back up on demand after that, and answered for as a DocsState the viewer draws.

// Pinned: an upgrade is a deliberate change here, and a container built from another image is recreated to match.
export const IMAGE = "onlyoffice/documentserver:9.4.0.1";
export const CONTAINER = "intentic-onlyoffice";
export const CONTAINER_LABELS: Readonly<Record<string, string>> = { "dev.intentic.extension": "intentic.onlyoffice" };
// The engine brings the container back at every boot: a cold start is minutes of generation nobody should wait on. An
// existing container without it is recreated once (or `docker update --restart unless-stopped` spares the restart).
export const RESTART_POLICY = "unless-stopped";

// A container's first start is about two and a half minutes (fonts, presentation themes, script caches and gzip are
// generated, none of it baked into the image), longer on a busy machine; a pull that just extracted 2 GB is slower
// still. Every start after that is seconds (SETUP_ONCE).
const HEALTHY_WITHIN_MS = 8 * 60 * 1000;
const HEALTH_POLL_MS = 1000;
const HEALTH_TIMEOUT_MS = 3000;

// The image's entrypoint redoes its whole setup on every start: font lists and thumbnails, presentation theme previews
// and the converter's script caches (~80 s), the default plugins fetched again from the marketplace, and a `gzip -9` of
// ~10k static files (~60 s). All of it lands in the container's own layer and stays valid for the container's life, so
// this runs the image's entrypoint with each step turned off once it has been done, and a start after the first (a
// sandbox boot, the open after an idle stop) takes seconds instead of minutes. A new image means a new container,
// which does it all once more.
export const SETUP_ONCE = [
    `DS=/var/www/onlyoffice/documentserver`,
    // The script caches are the pass's last step, so their presence means fonts and themes were finished too.
    `if [ -s "$DS/sdkjs/common/AllFonts.js" ] && [ -s "$DS/sdkjs/word/sdk-all.cache" ] && [ -s "$DS/sdkjs/cell/sdk-all.cache" ] && [ -s "$DS/sdkjs/slide/sdk-all.cache" ]; then export GENERATE_FONTS=false; fi`,
    `if ls -d "$DS"/sdkjs-plugins/{*} >/dev/null 2>&1; then export PLUGINS_ENABLED=false; fi`,
    // After one full pass only api.js wants it again: the cache-tag step rewrites it, and drops its .gz, every start.
    `if [ -s "$DS/sdkjs/word/sdk-all-min.js.gz" ]; then printf '#!/bin/sh\\ngzip -kf9 %s/web-apps/apps/api/documents/api.js\\n' "$DS" > /usr/bin/documentserver-static-gzip.sh; fi`,
    `exec /app/ds/run-document-server.sh`,
].join("\n");
export const ENTRYPOINT: readonly string[] = ["/bin/bash", "-c", SETUP_ONCE];

// The image names its static files under a cache tag it mints from the clock on every start, and serves them as
// immutable for a year; the editor's own service worker caches them by the same path. A tag per start threw all of it
// away at every sandbox boot and idle stop: the next open fetched some 50 MB again, through the tunnel. The tag is read
// from HASH when the environment has one, so each container gets one of its own at creation instead: stable for the
// container's life, fresh for a new image.
const CACHE_TAG = /^HASH=[0-9a-f]{32}$/;

// The healthcheck answers true well before the image's entrypoint is done: it still generates fonts, restarts the
// converter and the docservice and reloads nginx, and a document opened meanwhile fails to download. The entrypoint
// ends by tailing the service logs, and this is the banner that tail prints once it gets there.
export const SETUP_DONE_MARKER = "==> /var/log/onlyoffice/documentserver/docservice/out.log <==";

type Phase =
    | { readonly kind: "idle" }
    | { readonly kind: "pulling"; readonly percent: number | undefined }
    | { readonly kind: "starting" }
    | { readonly kind: "error"; readonly detail: string };

export interface DocumentServerDeps {
    readonly engine: DockerEngine;
    readonly image: string;
    // Shared with the container as its JWT secret; a container holding another one is recreated.
    readonly secret: string;
    readonly log: (line: string) => void;
    readonly healthy?: (port: number) => Promise<boolean>;
    readonly freePort?: () => Promise<number>;
    readonly sleep?: (ms: number) => Promise<void>;
    // The cache tag a new container is created with (CACHE_TAG); random unless a test pins it.
    readonly cacheTag?: () => string;
}

// GET /healthcheck answers the literal `true` once every service inside is up.
export const documentServerHealthy = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/healthcheck", timeout: HEALTH_TIMEOUT_MS }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => resolve(res.statusCode === 200 && body.trim() === "true"));
            res.on("error", () => resolve(false));
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
    });

// A loopback port nothing holds right now, for the container's published port.
export const freeLoopbackPort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : undefined;
            probe.close(() => (port === undefined ? reject(new Error("no port was assigned")) : resolve(port)));
        });
    });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class DocumentServer {
    private phase: Phase = { kind: "idle" };
    // Known once the container answered its healthcheck; unset again when it stops answering.
    private port: number | undefined;
    // When the server was last asked for, for the idle stop. Set by `bringUp` as well as `running()`: a server just
    // brought up has been used by definition, and starting the clock at 0 would stop it on the very next tick.
    private lastUsedAt = 0;
    // Counts the runs this backend has brought up (see `run()`).
    private runs = 0;
    private inFlight: Promise<void> | undefined;
    private readonly healthy: (port: number) => Promise<boolean>;
    private readonly freePort: () => Promise<number>;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly cacheTag: () => string;

    constructor(private readonly deps: DocumentServerDeps) {
        this.healthy = deps.healthy ?? documentServerHealthy;
        this.freePort = deps.freePort ?? freeLoopbackPort;
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.cacheTag = deps.cacheTag ?? (() => randomBytes(16).toString("hex"));
    }

    // The loopback port to proxy to, only while the server is known to answer.
    //
    // Doubles as the idle clock's only writer, because every caller of this is about to USE the server: the listener
    // asks for the port on each proxied request, and a save asks before fetching the document back. Nothing polls it —
    // `status()` reads `this.port` directly — so a stamp here means real traffic, not a page watching a spinner.
    running(): { readonly port: number } | undefined {
        if (this.port === undefined) {
            return undefined;
        }
        this.lastUsedAt = Date.now();
        return { port: this.port };
    }

    // Which run of the server is up: it changes whenever the server is brought up again, since a restarted server holds
    // none of the editing sessions the one before it held.
    run(): number {
        return this.runs;
    }

    // Stops the container once nothing has proxied through it for `idleMs`, and reports whether it did. An editor with its
    // socket open is somebody reading, however long they go without a request, so `editorsConnected` holds it too.
    //
    // WHY THIS EXISTS: the container carries `restart: unless-stopped`, so once started it outlives every document
    // anyone opened. Measured on a sandbox four hours after its last use: 27 processes, 122 MB resident and 2.6 GB of
    // swap — the single largest swapped-out thing on the box, and since the admission gate counts swap against the
    // cap (_sandbox/sandbox/src/workload/resource-budget.ts), 2.6 GB of headroom no turn could spend.
    //
    // Stopped, not removed: `ensureRunning` finds the stopped container and `bringUp` starts it again on the same
    // published port, so the cost of being wrong is one entrypoint wait, not a lost address.
    async stopIfIdle(idleMs: number, editorsConnected = 0): Promise<boolean> {
        if (this.port === undefined || this.busy()) {
            return false;
        }
        if (editorsConnected > 0) {
            this.lastUsedAt = Date.now();
            return false;
        }
        if (Date.now() - this.lastUsedAt < idleMs) {
            return false;
        }
        try {
            await this.deps.engine.stop(CONTAINER);
        } catch (error) {
            // Left running and retried on the next tick: a stop that failed is not worth a phase of its own, and
            // reporting `error` here would make the next `ensureRunning` swallow it as a failed start.
            this.deps.log(`could not stop the idle document server: ${errorMessage(error)}`);
            return false;
        }
        this.port = undefined;
        this.deps.log(`stopped the document server after ${Math.round(idleMs / 60_000)} minutes idle; the next open starts it again`);
        return true;
    }

    // A start or a pull under way; an error is not, so the next attempt tries again.
    private busy(): boolean {
        return this.phase.kind === "pulling" || this.phase.kind === "starting";
    }

    // Where things stand, starting nothing.
    async status(): Promise<DocsState> {
        if (this.phase.kind !== "idle") {
            return this.phaseState();
        }
        if (this.port !== undefined) {
            return { state: "ready" };
        }
        const off = await this.deps.engine.unreachable();
        if (off !== undefined) {
            return { state: "docker-off", detail: off };
        }
        try {
            const found = await this.deps.engine.inspect(CONTAINER);
            return found === undefined ? { state: "not-started" } : found.running ? { state: "starting" } : { state: "not-started" };
        } catch (error) {
            return { state: "error", detail: errorMessage(error) };
        }
    }

    // Adopts a container the engine is already running (its restart policy brought it back with the sandbox), so the
    // first open after this backend starts finds the server ready rather than waiting out the readiness check. A
    // stopped one stays stopped: the idle stop put it there, and an open or the owner's auto-start brings it back.
    async adopt(): Promise<void> {
        if (this.busy() || this.port !== undefined || (await this.deps.engine.unreachable()) !== undefined) {
            return;
        }
        let found: ContainerState | undefined;
        try {
            found = await this.deps.engine.inspect(CONTAINER);
        } catch (error) {
            this.deps.log(`could not look for a running document server: ${errorMessage(error)}`);
            return;
        }
        if (found?.running === true) {
            const running = found;
            this.launch(() => this.bringUp(running));
        }
    }

    // Brings an existing container back up; a container never created waits for the owner's start. Returns as soon
    // as the answer is known, with a start under way in the background.
    async ensureRunning(): Promise<DocsState> {
        if (this.busy()) {
            return this.phaseState();
        }
        // A failed attempt is reported once, to whoever polls next, then cleared so the attempt after it is fresh.
        if (this.phase.kind === "error") {
            const failed = this.phaseState();
            this.phase = { kind: "idle" };
            return failed;
        }
        if (this.port !== undefined) {
            if (await this.healthy(this.port)) {
                return { state: "ready" };
            }
            this.port = undefined;
        }
        const off = await this.deps.engine.unreachable();
        if (off !== undefined) {
            return { state: "docker-off", detail: off };
        }
        let found: ContainerState | undefined;
        try {
            found = await this.deps.engine.inspect(CONTAINER);
        } catch (error) {
            return { state: "error", detail: errorMessage(error) };
        }
        if (found === undefined) {
            return { state: "not-started" };
        }
        this.launch(() => this.bringUp(found));
        return this.phaseState();
    }

    // The owner's explicit start: the pull (once), the container, the wait for its healthcheck.
    async start(): Promise<DocsState> {
        if (this.busy()) {
            return this.phaseState();
        }
        // An explicit start after a failure is the retry.
        this.phase = { kind: "idle" };
        if (this.port !== undefined && (await this.healthy(this.port))) {
            return { state: "ready" };
        }
        const off = await this.deps.engine.unreachable();
        if (off !== undefined) {
            return { state: "docker-off", detail: off };
        }
        this.launch(async () => {
            if (!(await this.deps.engine.imagePresent(this.deps.image))) {
                this.phase = { kind: "pulling", percent: undefined };
                this.deps.log(`pulling ${this.deps.image}`);
                await this.deps.engine.pull(this.deps.image, (percent) => {
                    this.phase = { kind: "pulling", percent };
                });
            }
            await this.bringUp(await this.deps.engine.inspect(CONTAINER));
        });
        return this.phaseState();
    }

    // Blocks until the server answers or the start fails; what the tests and a caller that must wait use.
    async settled(): Promise<void> {
        await this.inFlight;
    }

    private phaseState(): DocsState {
        switch (this.phase.kind) {
            case "pulling":
                return { state: "pulling", percent: this.phase.percent };
            case "starting":
                return { state: "starting" };
            case "error":
                return { state: "error", detail: this.phase.detail };
            case "idle":
                return this.port === undefined ? { state: "not-started" } : { state: "ready" };
        }
    }

    private launch(work: () => Promise<void>): void {
        this.phase = { kind: "starting" };
        this.inFlight = work()
            .then(() => {
                this.phase = { kind: "idle" };
            })
            .catch((error: unknown) => {
                this.phase = { kind: "error", detail: errorMessage(error) };
                this.deps.log(`document server failed: ${errorMessage(error)}`);
            })
            .finally(() => {
                this.inFlight = undefined;
            });
    }

    // A container matching the pinned image and this secret, running and healthy; anything else is recreated.
    private async bringUp(found: ContainerState | undefined): Promise<void> {
        this.phase = { kind: "starting" };
        let port = found?.hostPort;
        if (found !== undefined && !this.matches(found)) {
            this.deps.log(`recreating ${CONTAINER}: it was built from another image, secret or entrypoint, or without the restart policy or cache tag`);
            await this.deps.engine.remove(CONTAINER);
            port = undefined;
        }
        if (port === undefined) {
            port = await this.freePort();
            await this.deps.engine.create(CONTAINER, {
                image: this.deps.image,
                env: [...this.env(), `HASH=${this.cacheTag()}`],
                hostPort: port,
                labels: CONTAINER_LABELS,
                entrypoint: ENTRYPOINT,
            });
        }
        // A container already running is adopted as of the run it is in; one started here is read from this moment.
        const since = found?.running === true && found.hostPort === port ? found.startedAt : Math.floor(Date.now() / 1000) - 1;
        await this.deps.engine.start(CONTAINER);
        await this.waitReady(port, since);
        this.port = port;
        this.runs += 1;
        this.lastUsedAt = Date.now();
        this.deps.log(`document server answering on 127.0.0.1:${port}`);
    }

    private matches(found: ContainerState): boolean {
        return (
            found.image === this.deps.image &&
            found.hostPort !== undefined &&
            found.env.includes(`JWT_SECRET=${this.deps.secret}`) &&
            found.env.some((entry) => CACHE_TAG.test(entry)) &&
            found.restart === RESTART_POLICY &&
            found.entrypoint.length === ENTRYPOINT.length &&
            found.entrypoint.every((part, index) => part === ENTRYPOINT[index])
        );
    }

    // The container reaches the sandbox at a private address (host.docker.internal), which the server refuses unless
    // told otherwise.
    private env(): string[] {
        return ["JWT_ENABLED=true", `JWT_SECRET=${this.deps.secret}`, "JWT_HEADER=Authorization", "ALLOW_PRIVATE_IP_ADDRESS=true"];
    }

    // Ready means the entrypoint has finished its setup for this run AND the healthcheck answers, in that order: the
    // healthcheck alone says yes in the middle of the setup's restarts.
    private async waitReady(port: number, sinceSeconds: number): Promise<void> {
        const deadline = Date.now() + HEALTHY_WITHIN_MS;
        let setupDone = false;
        while (Date.now() < deadline) {
            if (!setupDone && (await this.deps.engine.logs(CONTAINER, sinceSeconds)).includes(SETUP_DONE_MARKER)) {
                setupDone = true;
                this.deps.log(`document server finished its setup, waiting for its healthcheck`);
            }
            if (setupDone && (await this.healthy(port))) {
                return;
            }
            await this.sleep(HEALTH_POLL_MS);
        }
        throw new Error(`the document server did not answer its healthcheck within ${HEALTHY_WITHIN_MS / 60000} minutes`);
    }
}
