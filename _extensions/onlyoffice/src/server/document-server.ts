import http from "node:http";
import net from "node:net";
import type { DocsState } from "../contract.js";
import type { ContainerState, DockerEngine } from "./docker.js";

// The document server as one container in the sandbox's Docker engine: pulled and created on the owner's one explicit
// start, brought back up on demand after that, and answered for as a DocsState the viewer draws.

// Pinned: an upgrade is a deliberate change here, and a container built from another image is recreated to match.
export const IMAGE = "onlyoffice/documentserver:9.4.0.1";
export const CONTAINER = "intentic-onlyoffice";

// Cold start of the document server (nginx, docservice, converter, postgres, rabbitmq) is tens of seconds; a pull
// that just extracted 2 GB can be slower.
const HEALTHY_WITHIN_MS = 5 * 60 * 1000;
const HEALTH_POLL_MS = 2000;
const HEALTH_TIMEOUT_MS = 3000;

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
    private inFlight: Promise<void> | undefined;
    private readonly healthy: (port: number) => Promise<boolean>;
    private readonly freePort: () => Promise<number>;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly deps: DocumentServerDeps) {
        this.healthy = deps.healthy ?? documentServerHealthy;
        this.freePort = deps.freePort ?? freeLoopbackPort;
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    // The loopback port to proxy to, only while the server is known to answer.
    running(): { readonly port: number } | undefined {
        return this.port === undefined ? undefined : { port: this.port };
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
            this.deps.log(`recreating ${CONTAINER}: it was built from another image or secret`);
            await this.deps.engine.remove(CONTAINER);
            port = undefined;
        }
        if (port === undefined) {
            port = await this.freePort();
            await this.deps.engine.create(CONTAINER, {
                image: this.deps.image,
                env: this.env(),
                hostPort: port,
                labels: { "dev.intentic.extension": "intentic.onlyoffice" },
            });
        }
        // A container already running is adopted as of the run it is in; one started here is read from this moment.
        const since = found?.running === true && found.hostPort === port ? found.startedAt : Math.floor(Date.now() / 1000) - 1;
        await this.deps.engine.start(CONTAINER);
        await this.waitReady(port, since);
        this.port = port;
        this.deps.log(`document server answering on 127.0.0.1:${port}`);
    }

    private matches(found: ContainerState): boolean {
        return found.image === this.deps.image && found.hostPort !== undefined && found.env.includes(`JWT_SECRET=${this.deps.secret}`);
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
            setupDone ||= (await this.deps.engine.logs(CONTAINER, sinceSeconds)).includes(SETUP_DONE_MARKER);
            if (setupDone && (await this.healthy(port))) {
                return;
            }
            await this.sleep(HEALTH_POLL_MS);
        }
        throw new Error(`the document server did not answer its healthcheck within ${HEALTHY_WITHIN_MS / 60000} minutes`);
    }
}
