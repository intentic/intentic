import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { type Capability, deviceScopesOn } from "@intentic/sandbox-contract/schemas/capabilities";
import { STACKS_MANIFEST_PATH, type StackSpecInput,type HostStats } from "@intentic/sandbox-contract/schemas/deploys";
import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import type { CiProject } from "../ci/projects.js";
import type { FetchFn } from "../ci/providers.js";
import { gitOut, recordingLogger } from "../harness/route-fakes.testing.js";
import { opt } from "../opt.js";
import type { DeviceStack, StackImageDigests } from "@intentic/sandbox-contract/schemas/device-stacks";
import { STACK_DEVICE, stackDevice, type StackDeviceOptions, type ToolAnswer, type ToolCall } from "../hosts/stacks/device-stacks.testing.js";
import type { SecretUse } from "../secrets/secret-uses.js";
import { fileDeployGrants } from "./deploy-grants.js";
import { fileSecretMarks } from "./deploy-secret-marks.js";
import { createDeployWatch, type DeployWatchDeps } from "./deploy-watch.js";
import { fileDeployWatch } from "./deploy-watch-store.js";
import { createDeploysEngine } from "./deploys-engine.js";
import { fileDeploysStore } from "./deploys-store.js";

// THE DEPLOYS ENGINE OVER ONE FAKE COMPUTER (deploys-engine.ts): a workspace of real git repositories under `root`, its
// records and grants in files under `state`, the computer from device-stacks.testing.ts, and every secret use and
// listener message kept for the suite to read; and its watch (deploy-watch.ts) over the same, with a forge a suite
// answers. Not part of the build.

// The device card a manifest names: the fake computer's own id, paired with the shell on.
const DEVICE_CARD: Capability = { id: STACK_DEVICE, kind: "device", config: { ...deviceScopesOn(["shell"]), platform: "linux" } };

const writeFiles = async (dir: string, files: Readonly<Record<string, string>>): Promise<void> => {
    for (const [path, body] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), body);
    }
};

// Commits whatever is in the repository; its sha.
const commitAll = async (dir: string, message = "work"): Promise<string> => {
    await gitOut(dir, "add", "-A");
    await gitOut(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);
    return await gitOut(dir, "rev-parse", "HEAD");
};

// A repository at `<root>/<name>` on `main`, holding a compose file and a stacks manifest declaring `stacks`; its HEAD.
export const stackRepo = async (root: string, name: string, stacks: readonly StackSpecInput[]): Promise<string> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await gitOut(dir, "init", "-q", "-b", "main");
    await writeFiles(dir, { "compose.yaml": "services:\n  web:\n    image: ghcr.io/o/web:main\n", [STACKS_MANIFEST_PATH]: JSON.stringify({ stacks }) });
    return await commitAll(dir);
};

// A later commit with the manifest declaring `stacks` (and a marker file, so each commit differs); its sha.
export const restack = async (root: string, name: string, stacks: readonly StackSpecInput[], marker: string): Promise<string> => {
    await writeFiles(join(root, name), { [STACKS_MANIFEST_PATH]: JSON.stringify({ stacks }), "marker.txt": marker });
    return await commitAll(join(root, name), marker);
};

// What a deploy of the fake computer runs, unless a suite says otherwise.
export const DIGESTS: StackImageDigests = { web: "ghcr.io/o/web@sha256:1111111111111111111111111111111111111111111111111111111111111111" };

// What the fake computer's stack tools answer, each read per call: the stacks `list_stacks` lists (none by default), the
// digests a `deploy_stack` comes up with, what a `stack_action` printed, and `host_stats`.
export interface MachineAnswers {
    readonly stacks?: () => readonly DeviceStack[];
    readonly digests?: (call: ToolCall) => StackImageDigests;
    readonly action?: (call: ToolCall) => string;
    readonly hostStats?: () => HostStats;
}

export const stackMachine =
    (answers: MachineAnswers = {}) =>
    async (call: ToolCall): Promise<ToolAnswer> => {
        switch (call.tool) {
            case "list_stacks":
                return { text: JSON.stringify({ root: "/home/me/.intentic/stacks", stacks: answers.stacks?.() ?? [] }) };
            case "deploy_stack":
                return { text: JSON.stringify({ path: "/home/me/.intentic/stacks/web", output: "", digests: answers.digests?.(call) ?? DIGESTS }) };
            case "stack_action":
                return { text: answers.action?.(call) ?? "" };
            case "host_stats":
                return answers.hostStats === undefined ? { text: "unknown tool host_stats", refused: true } : { text: JSON.stringify(answers.hostStats()) };
            default:
                return { text: `unknown tool ${call.tool}`, refused: true };
        }
    };

// A managed stack this sandbox deployed, as `list_stacks` lists it, its services as given.
export const listedStack = (name: string, services: DeviceStack["services"], owner: DeviceStack["owner"] = { sandbox: "https://me.example.dev", you: true }): DeviceStack => ({
    name,
    status: "running(1)",
    configFiles: [`/home/me/.intentic/stacks/${name}/compose.yaml`],
    managed: true,
    ...opt("owner", owner),
    sandbox: false,
    services,
});

export interface DeployFixtureOptions extends Omit<StackDeviceOptions, "root"> {
    // The sandbox's own secret store.
    readonly stored?: Readonly<Record<string, string>>;
    readonly heldElsewhere?: (name: string) => Promise<string | undefined>;
    readonly gates?: readonly CredentialGate[];
    readonly cards?: readonly Capability[];
}

export const deployFixture = (root: string, state: string, over: DeployFixtureOptions = {}) => {
    const device = stackDevice({ ...over, root, features: over.features ?? ["stacks", "programs", "stacks-managed"] });
    const uses: SecretUse[] = [];
    const messages: ListenerMessage[] = [];
    const stored = over.stored ?? {};
    const recordsPath = join(state, "deploys.json");
    const deps = {
        root,
        store: fileDeploysStore(recordsPath),
        grantsStore: fileDeployGrants(join(state, "deploy-grants.json")),
        device: device.services,
        deviceCards: async () => over.cards ?? [DEVICE_CARD],
        secrets: {
            own: async (name: string) => stored[name],
            heldElsewhere: over.heldElsewhere ?? (async () => undefined),
            gates: async () => over.gates ?? [],
        },
        uses: {
            record: async (use: SecretUse) => {
                uses.push(use);
            },
        },
        fetchRemote: async () => "this suite's repositories have no remote",
        dispatch: async (message: ListenerMessage) => {
            messages.push(message);
        },
        logger: { warn: () => {} },
    };
    return { ...device, engine: createDeploysEngine(deps), deps, uses, messages, recordsPath };
};

export interface WatchFixtureOptions extends DeployFixtureOptions {
    // What the forge answers; absent, every call to it fails as unreachable.
    readonly fetch?: FetchFn;
    // The CI projects the workspace's repositories map to.
    readonly projects?: readonly CiProject[];
    readonly publicUrl?: string;
    readonly now?: () => number;
}

// The engine and its watch, the watch's memory and the secret marks in files under `state`. `stored` is the store the
// deploys render from, which a suite changes in place and announces with `secretsChanged`.
export const watchFixture = (root: string, state: string, over: WatchFixtureOptions = {}) => {
    const stored = { ...over.stored };
    const fixture = deployFixture(root, state, { ...over, stored });
    const secretListeners = new Set<() => void>();
    const { lines, logger } = recordingLogger();
    const watchPath = join(state, "deploy-watch.json");
    const watchDeps: DeployWatchDeps = {
        root,
        engine: fixture.engine,
        device: fixture.deps.device,
        deviceCards: fixture.deps.deviceCards,
        store: fileDeployWatch(watchPath),
        marks: fileSecretMarks(join(state, "deploy-secret-marks.json")),
        secretValue: async (name) => stored[name],
        onSecretsChanged: (listener) => {
            secretListeners.add(listener);
            return () => void secretListeners.delete(listener);
        },
        projectOf: async (repo) => over.projects?.find((project) => project.repo === repo),
        fetch:
            over.fetch ??
            (async () => {
                throw new Error("this suite's forge is not reachable");
            }),
        publicUrl: over.publicUrl,
        fetchRemote: fixture.deps.fetchRemote,
        dispatch: fixture.deps.dispatch,
        logger,
        ...opt("now", over.now),
    };
    const secretsChanged = (): void => {
        for (const listener of secretListeners) {
            listener();
        }
    };
    return { ...fixture, stored, watch: createDeployWatch(watchDeps), watchDeps, watchPath, secretsChanged, logged: lines };
};
