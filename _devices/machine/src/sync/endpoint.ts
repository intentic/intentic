import { sandboxNames } from "@intentic/sandbox-run";
import { isProjectPairing, isSandboxContainerName, type Pairing, pairingTransport, type SyncTransport } from "./config.js";
import { runProcess } from "./exec.js";
import { sshAlias } from "./ssh.js";
import { pairingSlugs } from "./swap-pause.js";

// WHERE THE SANDBOX'S SIDE OF A PAIRING IS REACHED, for everything that crosses to it: the Mutagen session, the port
// forwards, the bring-back's listing and fetch, and the residue probe. Two ways (config.ts `SyncTransport`):
// - ssh: the sandbox's own sync door (tunnel.ts), dialled at its loopback address or its public one. It reaches a sandbox
//   wherever it runs, a hosted one included, and is every pairing's but a docker one's.
// - docker: this machine's own Docker engine, for a project whose sandbox container runs on it. Mutagen's `docker://`
//   transport and `docker exec` carry what ssh carried, with no key, known_hosts entry, tunnel listener or public address
//   on the data path. Measured with Mutagen 0.18.1 on Docker Desktop, from Windows and from a WSL distro: the session up
//   in 2-4 s with Mutagen's agent installed by `docker cp` (against up to 90 s through the tunnel), and one-way-safe
//   behaving exactly as it does over ssh (an agent's edit kept in the sandbox as a conflict, nothing written here).
export type SandboxEndpoint = { readonly kind: "ssh"; readonly alias: string } | { readonly kind: "docker"; readonly container: string };

export const pairingEndpoint = (pairing: Pick<Pairing, "sandboxId" | "transport" | "container">): SandboxEndpoint =>
    pairingTransport(pairing) === "docker" && pairing.container !== undefined
        ? { kind: "docker", container: pairing.container }
        : { kind: "ssh", alias: sshAlias(pairing.sandboxId) };

// Mutagen's URL for a folder on the sandbox's side.
export const mutagenUrl = (endpoint: SandboxEndpoint, path: string): string =>
    endpoint.kind === "ssh" ? `${endpoint.alias}:${path}` : `docker://${endpoint.container}${path}`;

// Mutagen's forward destination for an address on the sandbox's side (`tcp:<host>:<port>`).
export const mutagenForwardUrl = (endpoint: SandboxEndpoint, address: string): string =>
    endpoint.kind === "ssh" ? `${endpoint.alias}:${address}` : `docker://${endpoint.container}:${address}`;

// How `sync list --template {{json .}}` names this endpoint: `{ protocol: "docker", host: <container> }` for one made
// with `docker://`, `{ protocol: "ssh", host: <alias> }` for one made over ssh.
export const liveIdentity = (endpoint: SandboxEndpoint): { readonly protocol: "ssh" | "docker"; readonly host: string } =>
    endpoint.kind === "ssh" ? { protocol: "ssh", host: endpoint.alias } : { protocol: "docker", host: endpoint.container };

// One shell command run beside the sandbox's copy. ssh hands its last argument to the far side's shell; `docker exec`
// is given that same string through `sh -c`, so a program sent either way (its quoting, its base64, its stdin) is byte
// for byte the same. `-i` keeps stdin open for the programs that read their input there.
export interface RemoteShell {
    readonly command: string;
    readonly argsFor: (shellCommand: string) => readonly string[];
    // The exit status this transport keeps for "never reached the sandbox", and how to say it. ssh keeps 255; docker
    // exec keeps none (a missing or stopped container exits 1) and says why on stderr, which a failure quotes instead.
    readonly unreachable?: { readonly status: number; readonly sentence: string } | undefined;
}

export const remoteShell = (endpoint: SandboxEndpoint, ssh: string, sshOptions: readonly string[]): RemoteShell =>
    endpoint.kind === "ssh"
        ? {
              command: ssh,
              argsFor: (shellCommand) => [...sshOptions, endpoint.alias, shellCommand],
              unreachable: { status: 255, sentence: "ssh could not reach the sandbox" },
          }
        : { command: "docker", argsFor: (shellCommand) => ["exec", "-i", endpoint.container, "sh", "-c", shellCommand] };

// What `docker inspect` says of one container, as far as recognising a sandbox needs.
export interface InspectedContainer {
    readonly running: boolean;
    readonly env: readonly string[];
}

export type InspectContainer = (container: string) => Promise<InspectedContainer | undefined>;

// One line per field, NUL-free: the running flag, then each environment entry. An entry cannot hold a newline (docker
// takes them from `KEY=value` lines and the run contract writes them so), so the split below is exact.
const INSPECT_FORMAT = "{{.State.Running}}{{range .Config.Env}}\n{{.}}{{end}}";

// Bounded well above a cold engine's answer: this sits on `sync setup`'s path and on a session's (re)creation, where a
// hung CLI must read as "not reachable this way", never as a wait.
const INSPECT_TIMEOUT_MS = 15_000;

// The real inspection: undefined for a container this engine does not have, an engine that is down, or no `docker` on
// PATH, all of which mean the same thing here (the sandbox is not reachable through Docker from this machine).
export const inspectContainer: InspectContainer = async (container) => {
    const result = await runProcess("docker", ["inspect", "--format", INSPECT_FORMAT, container], { timeoutMs: INSPECT_TIMEOUT_MS });
    if (result.status !== 0) {
        return undefined;
    }
    const [running, ...env] = result.stdout.replace(/\r/g, "").split("\n");
    return { running: running?.trim() === "true", env: env.filter((line) => line !== "") };
};

// Origin-only, so a trailing slash or a path on either spelling never makes the same sandbox read as another.
const originOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).origin : undefined);

// Whether a running container IS this pairing's sandbox: ic starts every sandbox it runs with its public address in
// SANDBOX_PUBLIC_URL (connect.rs), so a container whose name matches but whose address does not is someone else's, and
// a folder synced into it would land in the wrong sandbox. A sandbox with no public address cannot be recognised this
// way, and is reached over ssh as before.
export const servesSandbox = (inspected: InspectedContainer | undefined, sandboxUrl: string): boolean => {
    const wanted = originOf(sandboxUrl);
    if (inspected?.running !== true || wanted === undefined) {
        return false;
    }
    return inspected.env.some((entry) => entry.startsWith("SANDBOX_PUBLIC_URL=") && originOf(entry.slice("SANDBOX_PUBLIC_URL=".length)) === wanted);
};

// The container on THIS machine's engine that runs the sandbox at `sandboxUrl`, or undefined. ic names a sandbox's
// container after its slug, and a pairing's URL carries the slugs ic may have used (swap-pause.ts `pairingSlugs`), so
// the candidates are derived, never searched for; each is then checked to be running and to be this sandbox. A hosted
// sandbox, one on another computer, or one this engine cannot see answers undefined, and its pairing stays on ssh.
export const localSandboxContainer = async (sandboxUrl: string, inspect: InspectContainer = inspectContainer): Promise<string | undefined> => {
    for (const slug of pairingSlugs(sandboxUrl)) {
        const { container } = sandboxNames(slug);
        // oxlint-disable-next-line eslint/no-await-in-loop -- at most two candidates, and the first that is this sandbox wins
        if (isSandboxContainerName(container) && servesSandbox(await inspect(container), sandboxUrl)) {
            return container;
        }
    }
    return undefined;
};

// Whether a docker pairing's container is, right now, still its sandbox: asked before a session is (re)created through
// it, since a container name outlives what runs under it (a removed sandbox, a new one on the same engine).
export const dockerEndpointAnswers = async (container: string, sandboxUrl: string, inspect: InspectContainer = inspectContainer): Promise<boolean> =>
    servesSandbox(await inspect(container), sandboxUrl);

// What `--transport` may ask for: a transport by name, or `auto`, the default, which lets transportFor decide.
export type TransportAsk = "auto" | SyncTransport;

// HOW A NEW PAIRING REACHES ITS SANDBOX. A project folder whose sandbox container runs on this machine's
// own Docker engine is reached through Docker, with nothing on ssh, the tunnel or a public address on the data path;
// so are the projects host (whose forwards ride the same way) and a folder attached to it. Every other pairing over
// ssh, as before. `--transport` overrides the choice, and docker asked for where it cannot work is refused before the
// pairing token is spent. Stored as absent for ssh, the shape every earlier pairing has.
export const transportFor = async (
    asked: TransportAsk,
    placement: Pick<Pairing, "project" | "projectsHost">,
    sandboxUrl: string,
    locate: (sandboxUrl: string) => Promise<string | undefined> = localSandboxContainer,
): Promise<Pick<Pairing, "transport" | "container">> => {
    if (asked === "ssh") {
        return {};
    }
    if (!isProjectPairing(placement) && placement.projectsHost !== true) {
        if (asked === "docker") {
            throw new Error("--transport docker is for a project folder (--project): a workspace pairing's git bridge and state backup ride ssh.");
        }
        return {};
    }
    const container = await locate(sandboxUrl);
    if (container === undefined) {
        if (asked === "docker") {
            throw new Error(
                `--transport docker needs this sandbox's container running on this machine's Docker engine, and none here serves ${sandboxUrl}.`,
            );
        }
        return {};
    }
    return { transport: "docker", container };
};

// WHAT BECAME OF A DOCKER PAIRING'S CONTAINER, asked again on every prepare and every minute (gone.ts `dockerStep`), in
// the four words that rule needs: it serves this sandbox; it exists but does not (stopped, or another sandbox under the
// name); the engine answered and holds no container of that name; or the engine could not be asked. Only the third is
// news: a stopped container is a sandbox not started yet, and an engine that is down says nothing about any container.
export type ListContainers = (container: string) => Promise<readonly string[] | undefined>;

// `docker ps -a` narrowed to exactly that name: the names it prints, or undefined when the engine did not answer.
const listContainers: ListContainers = async (container) => {
    const result = await runProcess("docker", ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"], {
        timeoutMs: INSPECT_TIMEOUT_MS,
    });
    return result.status === 0
        ? result.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line !== "")
        : undefined;
};

export const containerState = async (
    container: string,
    sandboxUrl: string,
    { inspect = inspectContainer, list = listContainers }: { readonly inspect?: InspectContainer; readonly list?: ListContainers } = {},
): Promise<"serves" | "stopped" | "missing" | "unknown"> => {
    if (servesSandbox(await inspect(container), sandboxUrl)) {
        return "serves";
    }
    const names = await list(container);
    if (names === undefined) {
        return "unknown";
    }
    return names.includes(container) ? "stopped" : "missing";
};
