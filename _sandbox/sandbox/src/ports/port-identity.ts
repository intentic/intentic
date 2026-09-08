import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.handler.js";
import { LOCAL_MODEL_PREFIX } from "../capabilities/handlers/localmodel.handler.js";
import { PANEL_SESSION_PREFIX } from "../processes/managed-processes.js";
import type { ListeningPort } from "./port-scan.js";

// Turns scan evidence (argv, cwd, session) into a name, sentence and origin for each listener. Lives here, not in the
// view, since the facts that attribute a port (panel key to extension index, workspace root) exist only here.
// Evidence-ordered, not source-ordered: unmatched says so rather than guessing.

// workspace = something the user or their agent runs and might preview; system = the sandbox's own machinery.
export type PortKind = "workspace" | "system";

// Who put the port there; drives the row's icon and chip wording ("mine", "my agent's", "the box's").
export type PortOrigin =
    // A terminal the user opened (a web-* session).
    | "terminal"
    // An agent's terminal (agent-*) or a job the app ran on their behalf (job-*).
    | "agent"
    // A dev server the app started for a repository (the panel Start button).
    | "panel"
    // A background service belonging to an installed extension.
    | "extension"
    // A Docker container in this sandbox published it.
    | "container"
    // The sandbox's own runtime, started at boot.
    | "sandbox"
    // Nothing in procfs claims it: served from outside this container's process namespace.
    | "unknown";

export interface PortIdentity {
    // Two or three words a person would call it ("Vite dev server", "Container port").
    readonly title: string;
    // One UI sentence: what it does and, where known, who started it.
    readonly purpose: string;
    readonly origin: PortOrigin;
    readonly kind: PortKind;
}

// argv0's basename, e.g. docker-proxy from /usr/bin/docker-proxy; matchers below use the full command line.
const binaryOf = (command: string | undefined): string => {
    const argv0 = command?.split(" ")[0] ?? "";
    return argv0.slice(argv0.lastIndexOf("/") + 1);
};

// Where the image installs the daemon and its helpers; everything under it is the sandbox itself.
const SANDBOX_INSTALL_DIR = "/opt/sandbox/";

// Ordered most specific first: the extension backend host is also under the install dir, so it must be matched before
// the catch-all.
const SANDBOX_SERVICES: readonly { readonly match: (command: string, binary: string) => boolean; readonly identity: Omit<PortIdentity, "kind"> }[] = [
    {
        match: (command) => command.includes(`${SANDBOX_INSTALL_DIR}dist/extensions/backend/`),
        identity: {
            title: "Extension services",
            purpose: "Runs the background half of your installed extensions.",
            origin: "sandbox",
        },
    },
    {
        match: (command, binary) => command.includes(SANDBOX_INSTALL_DIR) || binary === "intentic",
        identity: {
            title: "Sandbox service",
            purpose: "The sandbox's own service, this app, your agents and the CLI all talk to it.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "opencode",
        identity: {
            title: "Agent engine",
            purpose: "An agent runtime the sandbox runs delegated work through.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "cli-proxy-api",
        identity: {
            title: "Model request router",
            purpose: "Sends your agents' model calls out to the provider accounts you connected.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "dockerd",
        identity: {
            title: "Docker engine",
            purpose: "Runs the containers started inside this sandbox.",
            origin: "sandbox",
        },
    },
    {
        // Named by the scan itself, from its fixed 127.0.0.11 bind; no process here owns it.
        match: (command) => command === "Docker embedded DNS",
        identity: {
            title: "Container name lookup",
            purpose: "How containers in this sandbox find each other by name.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "sshd",
        identity: {
            title: "SSH access",
            purpose: "How your own computer opens a shell into this sandbox.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "cloudflared",
        identity: {
            title: "Tunnel connector",
            purpose: "Keeps this sandbox reachable at its public address.",
            origin: "sandbox",
        },
    },
    {
        match: (_command, binary) => binary === "chrome" || binary === "chromium" || binary === "headless_shell",
        identity: {
            title: "Agent browser",
            purpose: "The browser your agents drive, this port is how they steer it.",
            origin: "sandbox",
        },
    },
];

// Names for argv shaped like node .../node_modules/.bin/<tool>; not a package registry, just enough to cover common dev
// servers. Anything missing falls back to its own binary name.
const TOOL_TITLES: readonly { readonly test: RegExp; readonly title: string }[] = [
    { test: /(^|\/)vite(\s|$)/, title: "Vite dev server" },
    { test: /(^|\/)next(\s|$)/, title: "Next.js dev server" },
    { test: /(^|\/)astro(\s|$)/, title: "Astro dev server" },
    { test: /(^|\/)nuxt(\s|$)/, title: "Nuxt dev server" },
    { test: /webpack(-dev-server)?(\s|$)/, title: "Webpack dev server" },
    { test: /storybook/, title: "Storybook" },
    { test: /(^|\/)turbo(\s|$)/, title: "Turbo task runner" },
    { test: /(^|\/)esbuild(\s|$)/, title: "esbuild server" },
    { test: /http[.-]server|(^|\/)serve(\s|$)/, title: "Static file server" },
    { test: /(^|\/)(uvicorn|gunicorn|flask)(\s|$)|manage\.py\s+runserver/, title: "Python web server" },
    { test: /(^|\/)rails(\s|$)/, title: "Rails server" },
    { test: /(^|\/)php(\s|$)/, title: "PHP server" },
    { test: /(^|\/)(postgres|postgresql)(\s|$)/, title: "PostgreSQL" },
    { test: /(^|\/)redis-server(\s|$)/, title: "Redis" },
    { test: /(^|\/)mongod(\s|$)/, title: "MongoDB" },
    { test: /(^|\/)mysqld(\s|$)/, title: "MySQL" },
    { test: /(^|\/)ollama(\s|$)/, title: "Ollama" },
];

// Repo-relative cwd, the way the view shows it; the workspace root prefix buys nothing repeated.
const relativeCwd = (cwd: string | undefined, workspaceRoot: string): string | undefined => {
    if (cwd === undefined || !cwd.startsWith(`${workspaceRoot}/`)) {
        return undefined;
    }
    return cwd.slice(workspaceRoot.length + 1);
};

// The id's name half, sentence-cased, is the display name (no display name in the manifest); a process name repeating
// it isn't said twice.
const extensionTitle = (extensionId: string, processName: string): string => {
    const name = extensionId.slice(extensionId.lastIndexOf(".") + 1).replace(/-/g, " ");
    const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    return processName === name ? capitalised : `${capitalised} ${processName.replace(/-/g, " ")}`;
};

// The container-side port from docker-proxy's argv; the host-side number is already the row's own port.
const containerPort = (command: string): string | undefined => /-container-port\s+(\d+)/.exec(command)?.[1];

// Panel key carried by a panel-<key> session, for sessions the process manager owns.
const panelKeyOf = (session: string | undefined): string | undefined =>
    session?.startsWith(PANEL_SESSION_PREFIX) === true ? session.slice(PANEL_SESSION_PREFIX.length) : undefined;

export interface PortAttribution {
    readonly workspaceRoot: string;
    // Service key to its extension process; without it a key's dashes can't be split back into id and process.
    readonly extensionProcesses: ReadonlyMap<string, { readonly extensionId: string; readonly processName: string }>;
    // Port to the supervised service assigned it; the daemon-spawned service has no session to claim it by.
    readonly servicePorts: ReadonlyMap<number, string>;
}

// Tool name, or the bare binary as its own title; a listener with no argv is handled earlier.
const toolTitle = (command: string, binary: string): string =>
    TOOL_TITLES.find(({ test }) => test.test(command))?.title ?? (binary === "" ? "Unnamed process" : binary);

// Asked only once the "what" is settled, so the two can't contradict; folder is the repo-relative cwd, the most useful
// fact when several dev servers run.
const startedBy = (
    listener: Pick<ListeningPort, "session" | "cwd">,
    folder: string | undefined,
): { readonly purpose: string; readonly origin: PortOrigin } => {
    const where = folder === undefined ? "" : ` in ${folder}`;
    const session = listener.session;
    if (session?.startsWith(WEB_SESSION_PREFIX) === true) {
        return { purpose: `Started in one of your terminals${where}.`, origin: "terminal" };
    }
    if (session?.startsWith(AGENT_SESSION_PREFIX) === true) {
        return { purpose: `Started by an agent in its terminal${where}.`, origin: "agent" };
    }
    if (session?.startsWith(JOB_SESSION_PREFIX) === true) {
        return { purpose: `Started by a job this app ran${where}.`, origin: "agent" };
    }
    const key = panelKeyOf(session);
    if (key !== undefined) {
        return { purpose: `The dev server this app runs for ${key.replaceAll("--", "/")}.`, origin: "panel" };
    }
    return folder === undefined
        ? { purpose: "Nothing in the sandbox claims this one, it answers from outside the container.", origin: "unknown" }
        : { purpose: `Running in ${folder}, outside any terminal this app can show.`, origin: "unknown" };
};

// A cwd inside a repo beats the binary name; a process from the sandbox's install dir is always system, wherever its
// cwd sits.
const kindOf = (origin: PortOrigin, listener: Pick<ListeningPort, "cwd">, workspaceRoot: string): PortKind => {
    if (origin === "sandbox" || origin === "extension") {
        return "system";
    }
    if (origin === "unknown") {
        return listener.cwd?.startsWith(workspaceRoot) === true ? "workspace" : "system";
    }
    return "workspace";
};

// Match order is the logic: sandbox processes and container ports go by argv (session says nothing true about them),
// extension services go by assigned port, panels by session; everything else falls back to command and cwd.
export const identifyPort = (listener: ListeningPort, attribution: PortAttribution): PortIdentity => {
    const command = listener.command ?? "";
    const binary = binaryOf(listener.command);
    const folder = relativeCwd(listener.cwd, attribution.workspaceRoot);

    if (command === "") {
        return {
            title: "Unclaimed port",
            purpose: "Something is listening here that no process in this sandbox owns, usually container plumbing.",
            origin: "unknown",
            kind: "system",
        };
    }

    // A user's own checkout beats every table below it, even for a binary the image also ships.
    const inRepo = folder !== undefined && folder !== "";

    if (!inRepo) {
        const known = SANDBOX_SERVICES.find(({ match }) => match(command, binary));
        if (known !== undefined) {
            return { ...known.identity, kind: kindOf(known.identity.origin, listener, attribution.workspaceRoot) };
        }
    }

    // Not the sandbox's own port; dockerd only provides the plumbing, the container is the user's to preview.
    if (binary === "docker-proxy") {
        const inside = containerPort(command);
        return {
            title: "Container port",
            purpose:
                inside === undefined
                    ? "A container running in this sandbox publishes a port here."
                    : `A container running in this sandbox publishes its port ${inside} here.`,
            origin: "container",
            kind: "workspace",
        };
    }

    // Recognized by the assigned port; a supervised service is the daemon's own child, with no session of its own.
    const serviceKey = attribution.servicePorts.get(listener.port);
    if (serviceKey !== undefined) {
        const owner = attribution.extensionProcesses.get(serviceKey);
        return {
            title: owner === undefined ? "Extension service" : extensionTitle(owner.extensionId, owner.processName),
            purpose:
                owner === undefined
                    ? "A background service an extension asked the sandbox to run."
                    : `A background service the ${owner.extensionId} extension asked the sandbox to run.`,
            origin: "extension",
            kind: "system",
        };
    }
    const key = panelKeyOf(listener.session);
    if (key !== undefined && key.startsWith(LOCAL_MODEL_PREFIX)) {
        return {
            title: "Local model server",
            purpose: "Serves a local language model for your agents.",
            origin: "sandbox",
            kind: "system",
        };
    }
    if (key === DOCKER_PANEL_KEY) {
        return {
            title: "Docker engine",
            purpose: "Runs the containers started inside this sandbox.",
            origin: "sandbox",
            kind: "system",
        };
    }

    const { purpose, origin } = startedBy(listener, folder === "" ? undefined : folder);
    return { title: toolTitle(command, binary), purpose, origin, kind: kindOf(origin, listener, attribution.workspaceRoot) };
};
