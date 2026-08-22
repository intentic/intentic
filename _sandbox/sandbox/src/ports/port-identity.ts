import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.js";
import { LOCAL_MODEL_PREFIX } from "../capabilities/handlers/localmodel.js";
import { EXTENSION_PROCESS_PREFIX } from "../extensions/extension-processes.js";
import { PANEL_SESSION_PREFIX } from "../processes/managed-processes.js";
import type { ListeningPort } from "./port-scan.js";

/* WHAT IS ON THIS PORT, SAID IN WORDS: the half the Ports view was missing.
 *
 * The scan answers with evidence: a port, an argv, a working directory, a tmux session. That is everything a
 * person needs to WORK OUT what is listening, and nothing they need to KNOW it. The view rendered the argv
 * verbatim, so `node --report-on-fatalerror --report-directory=/history/logs /opt/sandbox/dist/main.js` was the
 * entire explanation of a port the reader is being invited to publish to the internet, and three of the rows
 * on a stock sandbox were that one process wearing three different port numbers.
 *
 * So every listener gets a NAME, a SENTENCE and an ORIGIN, resolved from the strongest evidence available.
 * It lives in the daemon rather than in the view for the reason `kind` already does: the two facts that
 * actually attribute a port (the panel key → extension index, and the workspace root) exist here and nowhere
 * else, and a second copy of this table in a view would answer differently from the one the desktop mirror and
 * the CLI read.
 *
 * The rules are deliberately evidence-ordered, not source-ordered: a `docker-proxy` is a container's port
 * whichever session dockerd happened to be started from, while a plain `node` is only ever explained by where
 * it was launched. Anything that matches nothing says so plainly: "we don't know" is a better row than a
 * confident guess, because the button beside it publishes the port to the internet.
 */

// Which bucket the Ports view files a listener under: `workspace` = something the user (or their agent) runs
// and might want to preview; `system` = the sandbox's own machinery, listed for transparency below the fold.
export type PortKind = "workspace" | "system";

/* WHO PUT IT THERE. Drives the row's icon and how the view phrases the trailing chip, and it is the field a
 * reader is actually asking about when they ask what a port is: "mine", "my agent's", "the box's". */
export type PortOrigin =
    // A terminal the user opened themselves (a web-* session).
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
    // Two or three words, what a person would call it: "Vite dev server", "Sandbox service", "Container port".
    readonly title: string;
    // One sentence: what it does, and, where the evidence says so, who started it. Read straight into the
    // row's description line, so it is written as UI copy rather than as a log message.
    readonly purpose: string;
    readonly origin: PortOrigin;
    readonly kind: PortKind;
}

// argv0's basename: `/usr/bin/docker-proxy` → `docker-proxy`. The whole command line stays available to the
// matchers below, because a node process is only ever identified by the SCRIPT it was handed.
const binaryOf = (command: string | undefined): string => {
    const argv0 = command?.split(" ")[0] ?? "";
    return argv0.slice(argv0.lastIndexOf("/") + 1);
};

// Where the image installs the daemon and its helper processes. Everything under it is the sandbox itself, no
// matter that the daemon's own cwd is the workspace root, which is exactly how the daemon used to file itself
// under the user's own ports and hand the reader a Preview button for the service rendering the page.
const SANDBOX_INSTALL_DIR = "/opt/sandbox/";

/* The sandbox's own runtime, by the one piece of argv that names it. Ordered most specific first: the
 * extension backend host is also a script under the install dir, so it has to be recognised before the
 * catch-all that reads any of them as the daemon. */
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
        // The scan names this one itself, from its fixed 127.0.0.11 bind: no process in this namespace owns it.
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

/* What a dev server is CALLED, for the many rows whose argv is `node …/node_modules/.bin/<tool>`. Not an
 * attempt at a package registry: it is the short list of things that bind a port in a workspace, and anything
 * missing falls back to its own binary name, which is still a name, just a less friendly one. */
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

// A workspace path said the way the view says it: repo-relative, since everything the user runs lives under
// the workspace root and repeating it on every row buys nothing.
const relativeCwd = (cwd: string | undefined, workspaceRoot: string): string | undefined => {
    if (cwd === undefined || !cwd.startsWith(`${workspaceRoot}/`)) {
        return undefined;
    }
    return cwd.slice(workspaceRoot.length + 1);
};

// "intentic.discord" + "gateway" → "Discord gateway". The manifest carries no display name (identity is
// publisher.name), so the id's own name half IS the display name, sentence-cased, and a process whose name
// merely repeats the extension's ("discord" in `intentic.discord`) does not say it twice.
const extensionTitle = (extensionId: string, processName: string): string => {
    const name = extensionId.slice(extensionId.lastIndexOf(".") + 1).replace(/-/g, " ");
    const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    return processName === name ? capitalised : `${capitalised} ${processName.replace(/-/g, " ")}`;
};

// `-container-port 5432` out of docker-proxy's argv: the ONE fact that makes a published port legible, since
// the host-side number is already the row's own port and says nothing about what answers on it.
const containerPort = (command: string): string | undefined => /-container-port\s+(\d+)/.exec(command)?.[1];

// The panel key a session name carries, for the sessions the process manager owns (`panel-<key>`).
const panelKeyOf = (session: string | undefined): string | undefined =>
    session?.startsWith(PANEL_SESSION_PREFIX) === true ? session.slice(PANEL_SESSION_PREFIX.length) : undefined;

export interface PortAttribution {
    readonly workspaceRoot: string;
    /* Panel key → the extension process running in it (extensionProcessIndex). Without it a
     * `panel-ext-intentic-discord-gateway` session cannot be split back into an extension and a process name:
     * the dashes are ambiguous, and the row would be left calling somebody's gateway "node dist/gateway.js".
     * An empty map is fine: those rows fall back to the generic extension-service wording. */
    readonly extensionProcesses: ReadonlyMap<string, { readonly extensionId: string; readonly processName: string }>;
}

// The tool name, or the bare binary as its own title. Never empty: a listener with no readable argv at all is
// handled before this is reached.
const toolTitle = (command: string, binary: string): string =>
    TOOL_TITLES.find(({ test }) => test.test(command))?.title ?? (binary === "" ? "Unnamed process" : binary);

/* Where a listener came from, as a sentence: asked only once the WHAT is settled, so the two never contradict
 * each other. `folder` is the repo-relative cwd where there is one; a dev server's folder is the single most
 * useful thing on the row for somebody with three of them running. */
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

/* WHAT KIND OF THING IS THIS, for the two groups the view draws. Unchanged in spirit from the classification
 * this replaces: a cwd inside a repo still beats the binary name, so somebody running an agent runtime in
 * their own checkout keeps their row, with the one correction that motivated the rewrite: a process out of
 * the sandbox's install dir is the sandbox's, whatever directory it happens to sit in. */
const kindOf = (origin: PortOrigin, listener: Pick<ListeningPort, "cwd">, workspaceRoot: string): PortKind => {
    if (origin === "sandbox" || origin === "extension") {
        return "system";
    }
    if (origin === "unknown") {
        return listener.cwd?.startsWith(workspaceRoot) === true ? "workspace" : "system";
    }
    return "workspace";
};

/* One listener, named. The order below IS the argument: the sandbox's own processes and a container's
 * published port are recognised from their argv (they can be started from anywhere, and a session tells you
 * nothing true about them), an extension service and a panel are recognised from the session the manager
 * started them in, and only what is left over is read off its command and working directory. */
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

    // A user's own checkout beats every table below it: `opencode` run inside a repo is that person's work, not
    // the sandbox's copy of it, and the same goes for anything else the image happens to ship.
    const inRepo = folder !== undefined && folder !== "";

    if (!inRepo) {
        const known = SANDBOX_SERVICES.find(({ match }) => match(command, binary));
        if (known !== undefined) {
            return { ...known.identity, kind: kindOf(known.identity.origin, listener, attribution.workspaceRoot) };
        }
    }

    // A published container port. Not the sandbox's own (dockerd only provides the plumbing) and not
    // previewable-by-accident either: the row is one of the few where Preview is genuinely what you want.
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

    const key = panelKeyOf(listener.session);
    if (key !== undefined && key.startsWith(EXTENSION_PROCESS_PREFIX)) {
        const owner = attribution.extensionProcesses.get(key);
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
