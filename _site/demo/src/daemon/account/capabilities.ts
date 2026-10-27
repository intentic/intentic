import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import type {
    Capability,
    CapabilityProbe,
    CapabilityRecommendation,
    CapabilityStatus,
    CapabilitySummary,
    SshKey,
} from "@intentic/sandbox-contract/schemas/capabilities";
import type { RemoteRefs } from "@intentic/sandbox-contract/schemas/git/remote-refs";
import { Frames, refuse } from "@intentic/contract-serve";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { demoCapabilities } from "../../fixture/sandbox";
import { demoMode } from "../../mode";
import { forgetConnection, vaultConnection } from "./secrets";
import { pushRuntime } from "../runtimePush";

// The capability manifest as a store: connecting, editing, renaming and removing a connection change what the next list
// says, for this page load. An add streams its apply the way the daemon's handlers word it (capabilities/handlers/), so
// the form's log fills at a watchable pace, and every write pushes the `capabilities` domain to the other windows.

// The whole recording also has a model server connected: the office's GPU box, serving open-weights models over vLLM.
const OFFICE_GPU: CapabilitySummary = {
    id: `office-gpu`,
    kind: `endpoint`,
    status: { state: `active` },
    config: { baseUrl: `http://gpu.acme.internal:8000/v1`, protocol: `openai` },
    secrets: [`apiKey`],
};

let held: CapabilitySummary[] | undefined;
const connections = (): CapabilitySummary[] => (held ??= [...demoCapabilities(), ...(demoMode.id === `full` ? [OFFICE_GPU] : [])]);

// What the workspace asks for, from what is checked out: the shop's web app ships PostHog and deploys to Cloudflare.
const RECOMMENDED: CapabilityRecommendation[] = [
    {
        entry: `posthog`,
        evidence: `web/package.json: "posthog-js": "^1.180.0"`,
        reason: `The web app sends product analytics to PostHog, and no connection lets an agent read them back.`,
        prefill: { host: `https://eu.posthog.com` },
    },
    {
        entry: `cloudflare`,
        evidence: `web/wrangler.toml`,
        reason: `The web app deploys with Wrangler, so an agent needs a Cloudflare token to ship or roll it back.`,
        prefill: {},
    },
];
const dismissed = new Set<string>();

// Which settings hold a credential: the catalog marks them `secret`, and every one it marks is named like one of these.
const SECRET_FIELD = /token|secret|password|apikey|privatekey|^key$|seed|totp/iu;

// The daemon never echoes a credential: it strips them from `config` and names them in `secrets`.
const summarize = (capability: Capability, status: CapabilityStatus) => {
    const config: CapabilitySummary[`config`] = {};
    const secrets: string[] = [];
    let credential: string | undefined;
    for (const [key, value] of Object.entries(capability.config)) {
        if (SECRET_FIELD.test(key)) {
            secrets.push(key);
            // A VAULTED marker keeps what is stored; anything else is the new credential.
            if (typeof value === `string` && !value.startsWith(`VAULTED`)) {
                credential ??= value;
            }
        } else if (typeof value === `string` || typeof value === `number` || typeof value === `boolean`) {
            config[key] = value;
        }
    }
    const summary: CapabilitySummary = { id: capability.id, kind: capability.kind, status, config, secrets };
    return { summary, credential };
};

// The kinds that wait on a person after the apply: a machine or phone to pair, a browser to sign in once.
const statusAfterApply = (capability: Capability): CapabilityStatus => {
    switch (capability.kind) {
        case `device`:
            return { state: `pending`, detail: `run the pairing command on that computer` };
        case `phone`:
            return { state: `pending`, detail: `click Connect and scan the code with that phone's camera` };
        case `webext`:
            return { state: `pending`, detail: `click Connect and install the extension in that browser` };
        case `browser`:
            return { state: `pending`, detail: `sign in once in its browser` };
        default:
            return { state: `active` };
    }
};

// The handler's own lines for each kind, as the real apply prints them.
const kindLines = (kind: Capability[`kind`], id: string): string[] => {
    switch (kind) {
        case `cli`:
            return [`Writing ${id}'s skill and environment…`, `Checking the credential against the service…`, `Connected ${id}. The agent can use it next turn via its skill + the credential in its env.`];
        case `mcp`:
            return [`Registered MCP server ${id}, the agent can call it next turn.`];
        case `ssh`:
            return [`Writing the ssh config entry ${id}…`, `Trying ${id} once with the key…`, `Connected ${id}. The agent can reach it next turn via \`ssh ${id}\`.`];
        case `plugin`:
            return [`Cloning the plugin…`, `Loaded the plugin's skills and commands.`];
        case `extension`:
            return [`Cloning the extension…`, `Checked its manifest and permissions.`, `Started its backend.`];
        case `monorepo`:
            return [`Scaffolding pnpm + turbo monorepo "${id}"…`, `Monorepo "${id}" ready, open its panel to add apps (API / Web / Landing).`];
        case `device`:
            return [`Minted a pairing command for ${id}.`, `Waiting for ${id} to dial in.`];
        case `browser`:
            return [`Created a browser profile for ${id}.`];
        default:
            return [`Applying ${kind} connection ${id}…`, `Connected ${id}.`];
    }
};
const applyLines = (capability: Capability, editing: boolean): string[] => {
    const lines = kindLines(capability.kind, capability.id);
    return editing ? [`Updating ${capability.id}…`, ...lines] : lines;
};

const APPLY_STEP_MS = 500;

// Puts a row in the manifest, replacing one with the same id.
const write = (row: CapabilitySummary, replacing: boolean): void => {
    held = replacing ? connections().map((candidate) => (candidate.id === row.id ? row : candidate)) : [...connections(), row];
};

/** POST /capabilities: writes the connection at once (pending while it applies), then streams the apply a line at a
 *  time, ending on the result line with the row in the state the apply left it. */
export const addCapability = (capability: Capability): Frames<IntenticLine> => {
    const before = connections().find((row) => row.id === capability.id);
    const { summary, credential } = summarize(capability, statusAfterApply(capability));
    // An edit leaving a credential alone keeps the names it already held.
    summary.secrets = [...new Set([...(before?.secrets ?? []), ...summary.secrets])];
    write({ ...summary, status: { state: `pending`, detail: `applying`, settling: true } }, before !== undefined);
    if (summary.secrets.length > 0) {
        vaultConnection(summary.id, credential);
    }
    pushRuntime(`capabilities`);
    const lines = applyLines(capability, before !== undefined);
    return new Frames((sink) => {
        let step = 0;
        const timer = setInterval(() => {
            const line = lines[step];
            if (line !== undefined) {
                sink.emit({ kind: `log`, message: line });
                step += 1;
                return;
            }
            write(summary, true);
            pushRuntime(`capabilities`);
            sink.emit({ kind: `result`, ok: true });
            sink.close();
        }, APPLY_STEP_MS);
        return () => clearInterval(timer);
    });
};

const existing = (id: string): CapabilitySummary => connections().find((row) => row.id === id) ?? refuse(`no capability with that id`, 404);

// Docker is part of the sandbox and has no remove; every other kind tears down as a connection.
export const removeCapability = (id: string): void => {
    const capability = existing(id);
    if (capability.kind === `docker`) {
        refuse(`the docker capability can't be removed`, 409);
    }
    held = connections().filter((row) => row.id !== id);
    forgetConnection(id);
    pushRuntime(`capabilities`);
};

const renameRefusal = (kind: CapabilitySummary[`kind`]): string | undefined => {
    switch (kind) {
        case `docker`:
            return `Docker is part of the sandbox itself, not a connection you name.`;
        case `devops`:
            return `DevOps is one per sandbox and has no name of its own to change.`;
        case `monorepo`:
            return `This name is the monorepo's folder in your workspace, rename the repository itself instead.`;
        case `fleet`:
            return `there is one account connection per sandbox, so its name is not a handle anything uses`;
        default:
            return undefined;
    }
};

export const renameCapability = (id: string, to: string): void => {
    const capability = existing(id);
    const refused = renameRefusal(capability.kind);
    if (refused !== undefined) {
        refuse(refused, 409);
    }
    if (connections().some((row) => row.id === to)) {
        refuse(`"${to}" is already the name of another connection`, 409);
    }
    held = connections().map((row) => (row.id === id ? { ...row, id: to } : row));
    pushRuntime(`capabilities`);
};

export const setCapabilitySecret = (id: string, value: string): void => {
    const capability = existing(id);
    if (capability.secrets.length === 0) {
        refuse(`the ${capability.kind} capability holds no secret`, 409);
    }
    vaultConnection(id, value);
    held = connections().map((row) => (row.id === id ? { ...row, status: { state: `active` } } : row));
    pushRuntime(`capabilities`);
};

export const capabilityList = () => ({
    capabilities: connections(),
    recommendations: RECOMMENDED.filter((offer) => !dismissed.has(offer.entry) && !connections().some((row) => row.id === offer.entry)),
});

export const dismissRecommendation = (entry: string): void => {
    if (!RECOMMENDED.some((offer) => offer.entry === entry)) {
        refuse(`nothing is being recommended for that entry`, 404);
    }
    dismissed.add(entry);
};

// A probe answers as the service would: a credential that looks like one passes, a blank one is the service's refusal.
export const probeCapability = (capability: Capability): CapabilityProbe => {
    if (capability.kind !== `cli` && capability.kind !== `ssh` && capability.kind !== `mcp`) {
        return { checked: false, ok: false, message: `There is no test for a ${capability.kind} connection; it is checked when it is applied.` };
    }
    const { credential, summary } = summarize(capability, { state: `active` });
    const keeping = Object.values(capability.config).some((value) => typeof value === `string` && value.startsWith(`VAULTED`));
    if (summary.secrets.length > 0 && credential === undefined && !keeping) {
        return { checked: true, ok: false, message: `401 Unauthorized: the service refused an empty credential.` };
    }
    return { checked: true, ok: true, message: `The service answered as itself and accepted the credential.`, who: `acme` };
};

// The agent's sign-in runs in a terminal of its own, named the way the daemon names a capability's job session.
export const loginCapability = (id: string) => {
    if (existing(id).kind !== `agent`) {
        refuse(`no agent capability with that id`, 404);
    }
    return { session: `cap-${id}` };
};

// A stable 40-hex commit for a name, so the same repository advertises the same refs on every read.
const shaOf = (seed: string): string => {
    let out = ``;
    let hash = 2_166_136_261;
    while (out.length < 40) {
        for (const char of `${seed}${out.length}`) {
            hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0;
        }
        out += hash.toString(16).padStart(8, `0`);
    }
    return out.slice(0, 40);
};

/** What a remote advertises: its default branch, a working branch, and its last three release tags. */
export const remoteRefs = (url: string): RemoteRefs => ({
    defaultBranch: `main`,
    refs: [
        { name: `main`, kind: `branch`, sha: shaOf(`${url}#main`) },
        { name: `next`, kind: `branch`, sha: shaOf(`${url}#next`) },
        ...[`v1.4.0`, `v1.3.2`, `v1.3.1`].map((name) => ({ name, kind: `tag` as const, sha: shaOf(`${url}#${name}`) })),
    ],
});

let keys = 0;
/** A fresh ed25519 key pair's public half, the private half "held" under the token for an add to install. */
export const mintSshKey = (): SshKey => {
    keys += 1;
    const body = btoa(`demo-ed25519-${keys}-${shaOf(`key${keys}`)}`).replaceAll(`=`, ``);
    return { publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${body} intentic-acme-shop`, token: `sshkey-${shaOf(`token${keys}`).slice(0, 24)}` };
};

// What a connected model server lists when asked: a local model serves the one it runs, an Ollama the laptop's two, and
// any other OpenAI-compatible server the open-weights pair a shop would point one at.
export const endpointModels = (id: string): SandboxHandlerOutput<`endpoints`, `models`> => {
    const endpoint = existing(id);
    if (endpoint.kind !== `endpoint` && endpoint.kind !== `localmodel`) {
        refuse(`no endpoint with that id`, 404);
    }
    const listed =
        endpoint.kind === `localmodel`
            ? [String(endpoint.config[`model`] ?? `qwen3-coder-30b`)]
            : String(endpoint.config[`baseUrl`] ?? ``).includes(`11434`)
              ? [`qwen3:32b`, `llama3.2:latest`]
              : [`gpt-oss-120b`, `qwen3-coder-480b`];
    const models = listed.map((model) => ({ id: model, label: model }));
    return { models, default: listed[0] ?? `` };
};
