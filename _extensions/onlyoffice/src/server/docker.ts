import http from "node:http";

// The Docker Engine API over its unix socket, the handful of calls running one container needs. No `docker` CLI: the
// sandbox's engine is a feature pack that may be absent, and its absence is an answer this reports, not a crash.

export const DOCKER_SOCKET = "/var/run/docker.sock";

export interface EngineResponse {
    readonly status: number;
    readonly body: string;
}

export interface ContainerState {
    readonly running: boolean;
    // The loopback port the container's port 80 is published on; undefined when it was created without one.
    readonly hostPort: number | undefined;
    readonly image: string;
    readonly env: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
    // The engine's restart policy name ("no", "unless-stopped", …); what brings the container back at boot.
    readonly restart: string;
    // When the current run began, in unix seconds; 0 for a container never started.
    readonly startedAt: number;
}

export interface ContainerSpec {
    readonly image: string;
    readonly env: readonly string[];
    readonly hostPort: number;
    readonly labels: Readonly<Record<string, string>>;
}

export interface DockerEngine {
    // undefined when the engine answers; else why it does not (no socket, not running).
    readonly unreachable: () => Promise<string | undefined>;
    readonly imagePresent: (ref: string) => Promise<boolean>;
    // Streams the pull; `onProgress` gets a whole-image percentage as layers report.
    readonly pull: (ref: string, onProgress: (percent: number | undefined) => void) => Promise<void>;
    readonly inspect: (name: string) => Promise<ContainerState | undefined>;
    readonly create: (name: string, spec: ContainerSpec) => Promise<void>;
    readonly start: (name: string) => Promise<void>;
    // Stops and KEEPS; a container already stopped or gone is not an error. The idle stop uses this rather than
    // `remove` so the next open restarts the same container on the port it already holds.
    readonly stop: (name: string) => Promise<void>;
    // Stops and deletes; a container that is already gone is not an error.
    readonly remove: (name: string) => Promise<void>;
    // The container's output since a unix time, as text. The engine's frame headers are left in between the lines,
    // which a substring search does not mind.
    readonly logs: (name: string, sinceSeconds: number) => Promise<string>;
}

const request = (socketPath: string, method: string, path: string, body?: unknown): Promise<EngineResponse> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            {
                socketPath,
                method,
                path,
                headers: {
                    host: "docker",
                    ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        if (payload !== undefined) {
            req.write(payload);
        }
        req.end();
    });

const failure = (what: string, response: EngineResponse): Error => {
    let message = response.body.trim();
    try {
        const parsed: unknown = JSON.parse(response.body);
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string") {
            message = (parsed as { message: string }).message;
        }
    } catch {
        // Not JSON: the raw body is the message.
    }
    return new Error(`${what}: the Docker engine answered ${response.status}${message === "" ? "" : `, ${message}`}`);
};

// One layer's byte progress, kept per phase since a layer downloads first and extracts after.
interface LayerProgress {
    current: number;
    total: number;
}

// Download is the long phase and extraction the short one; weighted so the number keeps moving through both.
const DOWNLOAD_WEIGHT = 0.85;

export interface PullProgress {
    readonly downloading: Map<string, LayerProgress>;
    readonly extracting: Map<string, LayerProgress>;
}

export const newPullProgress = (): PullProgress => ({ downloading: new Map(), extracting: new Map() });

const ratioOf = (layers: Map<string, LayerProgress>): number | undefined => {
    let current = 0;
    let total = 0;
    for (const layer of layers.values()) {
        current += layer.current;
        total += layer.total;
    }
    return total === 0 ? undefined : Math.min(1, current / total);
};

const complete = (layers: Map<string, LayerProgress>, id: string): void => {
    const known = layers.get(id);
    layers.set(id, { current: known?.total ?? 1, total: known?.total ?? 1 });
};

interface PullEvent {
    readonly status?: string;
    readonly id?: string;
    readonly error?: string;
    readonly progressDetail?: { readonly current?: number; readonly total?: number };
}

// One layer's event into the phase it reports on.
const recordLayer = (progress: PullProgress, id: string, status: string, detail: { current?: number; total?: number }): void => {
    if (status === "Downloading" && detail.total !== undefined) {
        progress.downloading.set(id, { current: detail.current ?? 0, total: detail.total });
    } else if (status === "Download complete" || status === "Already exists") {
        complete(progress.downloading, id);
    } else if (status === "Extracting" && detail.total !== undefined) {
        progress.extracting.set(id, { current: detail.current ?? 0, total: detail.total });
    } else if (status === "Pull complete") {
        complete(progress.extracting, id);
    }
};

// The whole-image percent, undefined until any layer has reported a size.
const percentOf = (progress: PullProgress): number | undefined => {
    const downloaded = ratioOf(progress.downloading);
    if (downloaded === undefined) {
        return undefined;
    }
    const extracted = ratioOf(progress.extracting) ?? 0;
    return Math.round(100 * (DOWNLOAD_WEIGHT * downloaded + (1 - DOWNLOAD_WEIGHT) * extracted));
};

// Folds one line of the engine's pull stream into the progress and answers the percent after it. Throws on the
// stream's own `error` line.
export const pullProgressLine = (progress: PullProgress, line: string): number | undefined => {
    if (line.trim() === "") {
        return undefined;
    }
    const event = JSON.parse(line) as PullEvent;
    if (event.error !== undefined) {
        throw new Error(event.error);
    }
    if (event.id !== undefined && event.status !== undefined) {
        recordLayer(progress, event.id, event.status, event.progressDetail ?? {});
    }
    return percentOf(progress);
};

const splitRef = (ref: string): { image: string; tag: string } => {
    const colon = ref.lastIndexOf(":");
    const slash = ref.lastIndexOf("/");
    return colon > slash ? { image: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { image: ref, tag: "latest" };
};

const pullImage = (socketPath: string, ref: string, onProgress: (percent: number | undefined) => void): Promise<void> =>
    new Promise((resolve, reject) => {
        const { image, tag } = splitRef(ref);
        const req = http.request(
            {
                socketPath,
                method: "POST",
                path: `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
                headers: { host: "docker" },
            },
            (res) => {
                const progress = newPullProgress();
                let buffered = "";
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => {
                    buffered += chunk;
                    let newline = buffered.indexOf("\n");
                    while (newline !== -1) {
                        const line = buffered.slice(0, newline);
                        buffered = buffered.slice(newline + 1);
                        try {
                            const percent = res.statusCode === 200 ? pullProgressLine(progress, line) : undefined;
                            if (percent !== undefined) {
                                onProgress(percent);
                            }
                        } catch (error) {
                            // The stream's own error line: tearing the response down is what rejects, through `error` below.
                            res.destroy(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                        newline = buffered.indexOf("\n");
                    }
                });
                res.on("end", () => {
                    if (res.statusCode === 200) {
                        resolve();
                    } else {
                        reject(failure(`pulling ${ref}`, { status: res.statusCode ?? 0, body: buffered }));
                    }
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.end();
    });

// The container spec the engine's create call takes: port 80 published on loopback only, the sandbox reachable from
// inside the container as host.docker.internal, and the engine bringing the container back whenever it starts (a
// sandbox boot), since a cold start of this image is minutes of font, theme and gzip generation nobody should wait on.
export const createBody = (spec: ContainerSpec): Record<string, unknown> => ({
    Image: spec.image,
    Env: spec.env,
    Labels: spec.labels,
    ExposedPorts: { "80/tcp": {} },
    // Docker's own create-API key. Spelled anything else the engine keeps none of it: no published port, no
    // host-gateway entry, no restart policy.
    HostConfig: {
        PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(spec.hostPort) }] },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        RestartPolicy: { Name: "unless-stopped" },
    },
});

type PortBindings = Record<string, { readonly HostPort?: string }[] | null>;

interface InspectBody {
    readonly State?: { readonly Running?: boolean; readonly StartedAt?: string };
    readonly Config?: { readonly Image?: string; readonly Env?: string[]; readonly Labels?: Record<string, string> | null };
    // Live bindings, populated only while running; the created-with bindings live under HostConfig either way.
    readonly NetworkSettings?: { readonly Ports?: PortBindings };
    readonly HostConfig?: { readonly PortBindings?: PortBindings; readonly RestartPolicy?: { readonly Name?: string } };
}

const portOf = (bindings: PortBindings | undefined): number | undefined => {
    const binding = bindings?.["80/tcp"]?.[0]?.HostPort;
    const port = binding === undefined ? Number.NaN : Number.parseInt(binding, 10);
    return Number.isNaN(port) ? undefined : port;
};

// The loopback port the container's port 80 is published on, running or stopped.
const publishedPort = (parsed: InspectBody): number | undefined => portOf(parsed.NetworkSettings?.Ports) ?? portOf(parsed.HostConfig?.PortBindings);

// Unix seconds of an ISO time; 0 for the engine's zero time or nothing.
const secondsOf = (iso: string | undefined): number => {
    const millis = iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isNaN(millis) || millis <= 0 ? 0 : Math.floor(millis / 1000);
};

const restartPolicyOf = (parsed: InspectBody): string => parsed.HostConfig?.RestartPolicy?.Name ?? "no";

// The state an inspect answer describes.
export const parseInspect = (body: string): ContainerState => {
    const parsed = JSON.parse(body) as InspectBody;
    const config = parsed.Config ?? {};
    return {
        running: parsed.State?.Running === true,
        hostPort: publishedPort(parsed),
        image: config.Image ?? "",
        env: config.Env ?? [],
        labels: config.Labels ?? {},
        restart: restartPolicyOf(parsed),
        startedAt: secondsOf(parsed.State?.StartedAt),
    };
};

const probeEngine = async (socketPath: string): Promise<string | undefined> => {
    try {
        const response = await request(socketPath, "GET", "/_ping");
        return response.status === 200 ? undefined : `the Docker engine answered ${response.status} to a ping`;
    } catch (error) {
        const code = (error as { code?: string }).code;
        return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES"
            ? "Add the Docker capability on the Capabilities page to turn it on."
            : `the Docker engine is not answering (${error instanceof Error ? error.message : String(error)})`;
    }
};

const inspectContainer = async (socketPath: string, name: string): Promise<ContainerState | undefined> => {
    const response = await request(socketPath, "GET", `/containers/${encodeURIComponent(name)}/json`);
    if (response.status === 404) {
        return undefined;
    }
    if (response.status !== 200) {
        throw failure(`inspecting ${name}`, response);
    }
    return parseInspect(response.body);
};

const createContainer = async (socketPath: string, name: string, spec: ContainerSpec): Promise<void> => {
    const response = await request(socketPath, "POST", `/containers/create?name=${encodeURIComponent(name)}`, createBody(spec));
    if (response.status !== 201) {
        throw failure(`creating ${name}`, response);
    }
};

const startContainer = async (socketPath: string, name: string): Promise<void> => {
    const response = await request(socketPath, "POST", `/containers/${encodeURIComponent(name)}/start`);
    // 304: already running, which is what was asked for.
    if (response.status !== 204 && response.status !== 304) {
        throw failure(`starting ${name}`, response);
    }
};

const containerLogs = async (socketPath: string, name: string, sinceSeconds: number): Promise<string> => {
    const response = await request(socketPath, "GET", `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&since=${Math.max(0, Math.floor(sinceSeconds))}`);
    if (response.status !== 200) {
        throw failure(`reading ${name}'s log`, response);
    }
    return response.body;
};

// Stops without deleting, so the next open restarts THIS container on the port it already holds rather than creating
// one; `bringUp` reuses `hostPort` when it finds a container, and a recreate would hand the editor a new address.
const stopContainer = async (socketPath: string, name: string): Promise<void> => {
    const response = await request(socketPath, "POST", `/containers/${encodeURIComponent(name)}/stop`);
    // 304: already stopped, 404: already gone. Both are the state this asked for.
    if (response.status !== 204 && response.status !== 304 && response.status !== 404) {
        throw failure(`stopping ${name}`, response);
    }
};

const removeContainer = async (socketPath: string, name: string): Promise<void> => {
    const response = await request(socketPath, "DELETE", `/containers/${encodeURIComponent(name)}?force=true`);
    if (response.status !== 204 && response.status !== 404) {
        throw failure(`removing ${name}`, response);
    }
};

export const createDockerEngine = (socketPath: string = DOCKER_SOCKET): DockerEngine => ({
    unreachable: () => probeEngine(socketPath),
    imagePresent: async (ref) => (await request(socketPath, "GET", `/images/${encodeURIComponent(ref)}/json`)).status === 200,
    pull: (ref, onProgress) => pullImage(socketPath, ref, onProgress),
    inspect: (name) => inspectContainer(socketPath, name),
    create: (name, spec) => createContainer(socketPath, name, spec),
    start: (name) => startContainer(socketPath, name),
    stop: (name) => stopContainer(socketPath, name),
    remove: (name) => removeContainer(socketPath, name),
    logs: (name, sinceSeconds) => containerLogs(socketPath, name, sinceSeconds),
});
