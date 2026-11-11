import { LOCAL_PORT, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import {
    AGENT_AUTH_ROOT,
    AT_REST_KEY_ENV,
    AT_REST_KEY_MOUNT,
    COMPOSE_MANAGER,
    RUNTIME_DIRECTIVE_PREFIX,
    RUNTIME_DIRECTIVES,
    sandboxNames,
    sandboxRunSpec,
    type SandboxRun,
    type SandboxRunSpec,
} from "./index.js";
import { envLine } from "./quote.js";
import { REPLAY_SECRET_ENV } from "./replay.js";
import { slugOfHostname } from "./slug.js";

/* THE RUN CONTRACT AS A COMPOSE FILE. The same `sandboxRunSpec` the `docker run` line is rendered from, spelled as one
 * Compose service, so a sandbox Compose runs is the sandbox `ic` runs: its stop grace, caps, directives and their stamps,
 * at-rest key, overlay build and the side stamps that say which machine keeps it. Three hand copies of this file (the
 * setup page's, the docs quickstart's, the rebuild card's snippet) had each drifted from the run line before
 * (2026-11-11); they are renderings of this now.
 *
 * What only Compose needs rides beside the run: the approved overlay recipe, which Compose builds itself on `up`
 * (`build.dockerfile_inline`) since nothing else on a Compose host would; the at-rest key's host path; the HOST_* stamps;
 * and whether the storage already exists. Credentials never appear in the file: each is `${NAME:?…}`, and its value comes
 * back in `env` for the `.env` beside it (`composeEnvFile`). Browser-safe: nothing here imports Node. */

// The Compose service every rendering names.
const COMPOSE_SERVICE = "intentic-sandbox";

// What an unfilled credential says when Compose reads the file without its `.env`.
const MISSING_ENV = "run the .env bootstrap first";

// The credentials, which the file names only as variables of its `.env`.
const SECRET_NAMES: ReadonlySet<string> = REPLAY_SECRET_ENV;

// The approved overlay recipe, as the daemon wrote it to environment.approved.Dockerfile, and its hash.
export interface ComposeRecipe {
    readonly content: string;
    readonly hash: string;
}

// A variable the file reads from `.env` without this renderer knowing its value: the setup page's, whose credentials
// the platform's claim writes there. `missing` makes it required, saying that when it is absent; without it, it may be
// empty.
export interface EnvFileVar {
    readonly name: string;
    readonly missing?: string;
}

// The machine Compose runs the sandbox on, as `ic` stamps one: HOST_PLATFORM, HOST_LABEL, HOST_ENV.
export interface ComposeHost {
    platform?: string;
    label?: string;
    env?: string;
}

export interface ComposeInputs {
    readonly recipe?: ComposeRecipe | undefined;
    // Where the at-rest key is on the Compose host, as the file names it (a path relative to the file's folder works).
    readonly atRestKey?: string;
    // The side stamps (`ic`'s side.rs): without HOST_PLATFORM every `ic` reads the container as its own to restart.
    readonly host?: ComposeHost;
    // The volumes and network already exist (a sandbox moved or handed over to Compose): `external: true`, so a
    // `compose down` never deletes a workspace. False for a new sandbox, whose storage Compose creates.
    readonly existingStorage?: boolean;
    readonly envFile?: readonly EnvFileVar[];
    // The host is not known where the file is written (the setup page): no cgroup caps, rather than the run contract's
    // fallback for an unmeasured machine, which would hold a large server to 7g. The owner's SANDBOX_MEMORY still caps a
    // later recreate `ic` makes.
    readonly unmeasured?: boolean;
}

export interface SandboxCompose {
    // The compose.yaml text.
    readonly compose: string;
    // What the `.env` beside it must hold: every credential, and LOCAL_PORT.
    readonly env: Readonly<Record<string, string>>;
}

// The 12 hex an overlay image is tagged with, as `ic` tags the one it builds (intentic-sandbox-env-<slug>:<hex12>).
const hashTag = (hash: string): string => hash.replace(/^sha256:/u, "").slice(0, 12);

// A line that builds something: not blank, not a comment (directives are comments too), not the base's FROM.
const isStep = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && !/^FROM\s/iu.test(trimmed);
};

// Whether a recipe has steps beyond its base: one with none (only directives, as the docker capability on a base that
// carries the engine) runs the base image as it is.
export const recipeBuilds = (content: string): boolean => content.split("\n").some(isStep);

// The allowlist as plain strings, for testing tokens read off a file.
const ALLOWED_DIRECTIVES: readonly string[] = RUNTIME_DIRECTIVES;

// The allowlisted runtime directives of a recipe. One the daemon composed holds no others; a hand-edited one keeps those
// it may, and the rest of its file, rather than stopping the whole rendering over a token the run line would refuse.
const recipeDirectivesOf = (content: string): string[] => [
    ...new Set(
        content
            .split("\n")
            .filter((line) => line.startsWith(RUNTIME_DIRECTIVE_PREFIX))
            .flatMap((line) => line.slice(RUNTIME_DIRECTIVE_PREFIX.length).trim().split(/\s+/u))
            .filter((token) => ALLOWED_DIRECTIVES.includes(token)),
    ),
];

// The heredoc delimiters a Dockerfile line opens (`<<EOF`, `<<-"EOF"`), in the order their bodies follow it.
const heredocsOpenedBy = (line: string): string[] =>
    [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_]\w*)\1/gu)].map((match) => match[2] ?? "").filter((tag) => tag !== "");

// The recipe as Compose needs it in the file: its instructions without the comments and blank lines around them (the
// daemon's header, each fragment's explanation, the directives said as service keys). Docker drops those lines itself,
// so the build is the same; a heredoc's body is kept whole, since a `#` there is the script's own line.
export const recipeBuildLines = (content: string): string[] => {
    const lines: string[] = [];
    const open: string[] = [];
    for (const line of content.trimEnd().split("\n")) {
        if (open.length > 0) {
            lines.push(line);
            if (line.trim() === open[0]) {
                open.shift();
            }
            continue;
        }
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }
        lines.push(line);
        open.push(...heredocsOpenedBy(line));
    }
    return lines;
};

// `$` doubled: Compose interpolates every value in its file, and would read a recipe's shell (`$(node -p …)`) or a
// value's own dollar as a variable of the file.
const literal = (text: string): string => text.replaceAll("$", "$$$$");

// A YAML double-quoted scalar: JSON's string syntax is a subset of it.
const quoted = (text: string): string => JSON.stringify(text);

interface ComposeImage {
    readonly image: string;
    readonly lines: string[];
}

// The image of a sandbox and how Compose gets it: built from the recipe when it has steps, else pulled.
const imageLines = (run: SandboxRun, recipe: ComposeRecipe | undefined): ComposeImage => {
    if (recipe !== undefined && recipeBuilds(recipe.content)) {
        const image = `intentic-sandbox-env-${run.names.container.replace(/^intentic-sandbox-/u, "")}:${hashTag(recipe.hash)}`;
        return {
            image,
            lines: [
                `image: ${quoted(image)}`,
                // Compose builds this on `up`; `pull: true` refreshes the base the recipe names.
                "pull_policy: build",
                "build:",
                "    pull: true",
                "    dockerfile_inline: |",
                ...recipeBuildLines(recipe.content).map((line) => (line === "" ? "" : `        ${literal(line)}`)),
            ],
        };
    }
    // A registry-less tag is a local build that no registry has: pulling it would fail the `up`.
    const first = run.image.split("/")[0] ?? "";
    const registry = run.image.includes("/") && /[.:]/u.test(first);
    return { image: run.image, lines: [`image: ${quoted(run.image)}`, `pull_policy: ${registry ? "always" : "missing"}`] };
};

// The service keys each allowlisted directive becomes (RUNTIME_DIRECTIVES); NET_ADMIN joins the capabilities instead.
const directiveKeys = (directives: readonly string[]): string[] =>
    directives.flatMap((token) => {
        switch (token) {
            case "--privileged":
                return ["privileged: true"];
            case "--device=/dev/net/tun":
                return [`devices: ["/dev/net/tun:/dev/net/tun"]`];
            case "--gpus=all":
                return ["gpus: all"];
            default:
                return [];
        }
    });

// The service's capabilities: the contract's, and NET_ADMIN when a directive asks for it.
const capabilitiesOf = (spec: SandboxRunSpec): string[] => [
    ...spec.capabilities,
    ...spec.directives.flatMap((token) => (token.startsWith("--cap-add=") ? [token.slice("--cap-add=".length)] : [])),
];

// A mount's source when it names a volume rather than a path on the host: such a source needs a `volumes:` entry.
const volumeSourceOf = (mount: string): string | undefined => {
    const source = mount.split(":")[0] ?? "";
    return /^[\w][\w.-]*$/u.test(source) ? source : undefined;
};

// The container's env as one ordered map: the spec's pairs, then what only a Compose container carries. A later pair
// replaces an earlier one of the same name, since a YAML map cannot hold a key twice.
const environmentOf = (spec: SandboxRunSpec, inputs: ComposeInputs, image: string): Map<string, string> => {
    const env = new Map<string, string>();
    for (const [name, value] of spec.env) {
        env.set(name, value);
    }
    env.set("SANDBOX_IMAGE", image);
    if (inputs.recipe !== undefined) {
        env.set("SANDBOX_ENVIRONMENT_HASH", inputs.recipe.hash);
    }
    if (inputs.atRestKey !== undefined) {
        env.set(AT_REST_KEY_ENV, AT_REST_KEY_MOUNT);
    }
    const host = inputs.host ?? {};
    for (const [name, value] of [
        ["HOST_PLATFORM", host.platform],
        ["HOST_LABEL", host.label],
        ["HOST_ENV", host.env],
    ] as const) {
        if (value !== undefined && value !== "") {
            env.set(name, value);
        }
    }
    // Tells the daemon (and `ic`, compose.rs) Compose owns this container: its updates are Compose's.
    env.set("SANDBOX_MANAGER", COMPOSE_MANAGER);
    return env;
};

interface ComposeEnvironment {
    readonly lines: string[];
    readonly envFile: Record<string, string>;
}

// The environment block's lines, each credential as a variable of the `.env`, and what that `.env` must hold.
const environmentLines = (env: Map<string, string>, inputs: ComposeInputs): ComposeEnvironment => {
    const envFile: Record<string, string> = {};
    const lines: string[] = [];
    for (const [name, value] of env) {
        if (SECRET_NAMES.has(name)) {
            envFile[name] = value;
            lines.push(`${name}: \${${name}:?${MISSING_ENV}}`);
        } else {
            lines.push(`${name}: ${quoted(literal(value))}`);
        }
    }
    for (const { name, missing } of inputs.envFile ?? []) {
        if (!env.has(name)) {
            lines.push(`${name}: \${${name}${missing === undefined ? ":-" : `:?${missing}`}}`);
        }
    }
    return { lines, envFile };
};

// `name:` and, for storage that is already there, `external: true`.
const storageEntry = (key: string, name: string, existing: boolean): string[] => [`    ${key}:`, `        name: ${name}`, ...(existing ? ["        external: true"] : [])];

// The cgroup caps as service keys; none where the host is not known.
const resourceLines = (spec: SandboxRunSpec, inputs: ComposeInputs): string[] => {
    if (spec.resources === undefined || inputs.unmeasured === true) {
        return [];
    }
    const { memory, memorySwap, cpus } = spec.resources;
    return [`mem_limit: ${memory}`, `memswap_limit: ${memorySwap}`, ...(cpus === undefined ? [] : [`cpus: ${cpus}`])];
};

// `--label key=value` as a `labels:` map.
const labelLines = (labels: readonly string[]): string[] => {
    if (labels.length === 0) {
        return [];
    }
    return [
        "labels:",
        ...labels.map((label) => {
            const eq = label.indexOf("=");
            return eq === -1 ? `    ${quoted(label)}: ""` : `    ${quoted(label.slice(0, eq))}: ${quoted(literal(label.slice(eq + 1)))}`;
        }),
    ];
};

// The extra mounts. The key ic mounted beside the run line is the one named here, so a mount of it among the extras is
// dropped for the one beside the file.
const mountsOf = (spec: SandboxRunSpec, inputs: ComposeInputs): string[] => {
    const key = inputs.atRestKey;
    if (key === undefined) {
        return [...spec.mounts];
    }
    return [...spec.mounts.filter((mount) => !mount.includes(`:${AT_REST_KEY_MOUNT}`)), `${key}:${AT_REST_KEY_MOUNT}:ro`];
};

// The published ports: the hosted ones as they are, then the loopback shortcut, whose port the `.env` holds as
// LOCAL_PORT (filled in here when the run's id derives it, else by the setup page's claim).
const portsOf = (run: SandboxRun, spec: SandboxRunSpec, envFile: Record<string, string>): string[] => {
    if (run.localPublish === false) {
        return [...(run.ports ?? [])];
    }
    const derived = run.sandboxId === undefined ? undefined : spec.publish.at(-1)?.split(":")[1];
    if (derived !== undefined) {
        envFile["LOCAL_PORT"] = derived;
    }
    return [...(run.ports ?? []), `127.0.0.1:\${LOCAL_PORT:?${MISSING_ENV}}:${LOCAL_PORT}`];
};

// The overlay's directives: the run's own, else the recipe's.
const withRecipeRuntime = (run: SandboxRun, recipe: ComposeRecipe | undefined): SandboxRun =>
    run.runtime !== undefined || recipe === undefined ? run : { ...run, runtime: recipeDirectivesOf(recipe.content) };

// The service's keys, in the order a reader looks for them.
const serviceLines = (run: SandboxRun, spec: SandboxRunSpec, inputs: ComposeInputs, image: ComposeImage, environment: ComposeEnvironment): string[] => {
    const ports = portsOf(run, spec, environment.envFile);
    return [
        ...image.lines,
        `container_name: ${spec.container}`,
        ...(spec.init ? ["init: true"] : []),
        `restart: ${spec.restart}`,
        // Compose's default is 10 s, which cut the daemon's own shutdown short: a SIGKILL an agent then read as a crash.
        `stop_grace_period: ${spec.stopTimeoutSeconds}s`,
        `cap_add: [${capabilitiesOf(spec).join(", ")}]`,
        ...directiveKeys(spec.directives),
        ...resourceLines(spec, inputs),
        ...(spec.dns.length === 0 ? [] : [`dns: [${spec.dns.join(", ")}]`]),
        `extra_hosts: [${spec.extraHosts.map(quoted).join(", ")}]`,
        ...labelLines(spec.labels),
        "networks:",
        "    intentic:",
        ...(spec.networkAlias === undefined ? [] : [`        aliases: [${spec.networkAlias}]`]),
        "logging:",
        "    driver: json-file",
        `    options: { ${spec.logOptions.map(([key, value]) => `${key}: ${quoted(value)}`).join(", ")} }`,
        ...(ports.length === 0 ? [] : ["ports:", ...ports.map((port) => `    - ${quoted(port)}`)]),
        "volumes:",
        ...spec.volumes.map(({ volume, destination }) => `    - ${volume.composeKey}:${destination}`),
        ...mountsOf(spec, inputs).map((mount) => `    - ${quoted(literal(mount))}`),
        "environment:",
        ...environment.lines.map((line) => `    ${line}`),
    ];
};

// The run as a Compose file and the `.env` it reads. `run` is what `sandboxRunArgv` takes, rendered through the same
// spec; `run.ports` ride as they are, and the loopback shortcut reads its port from LOCAL_PORT in the `.env`.
export const sandboxCompose = (run: SandboxRun, inputs: ComposeInputs = {}): SandboxCompose => {
    const spec = sandboxRunSpec(withRecipeRuntime(run, inputs.recipe));
    const existing = inputs.existingStorage !== false;
    const image = imageLines(run, inputs.recipe);
    const environment = environmentLines(environmentOf(spec, inputs, image.image), inputs);
    const service = serviceLines(run, spec, inputs, image, environment);
    const mountVolumes = [...new Set(mountsOf(spec, inputs).flatMap((mount) => volumeSourceOf(mount) ?? []))];
    const compose = [
        `# ${spec.container}, rendered from the intentic run contract (@intentic/sandbox-run/compose).`,
        // A sandbox that already runs can be written again from what it runs; a new one is the setup page's to fill in.
        ...(existing ? ["# Regenerate it rather than editing it: `ic sandbox compose <slug>` on the machine running it."] : []),
        "services:",
        `    ${COMPOSE_SERVICE}:`,
        ...service.map((line) => (line === "" ? "" : `        ${line}`)),
        "networks:",
        ...storageEntry("intentic", spec.network, existing),
        "volumes:",
        ...spec.volumes.flatMap(({ volume, name }) => storageEntry(volume.composeKey, name, existing)),
        ...mountVolumes.flatMap((name) => storageEntry(name, name, existing)),
        "",
    ].join("\n");
    return { compose, env: environment.envFile };
};

// The `.env` text for `env`, one quoted line each (envLine: Compose strips the quotes it picks).
export const composeEnvFile = (env: Readonly<Record<string, string>>): string =>
    Object.entries(env)
        .map(([name, value]) => envLine(name, value))
        .join("");

/* A NEW SANDBOX'S FILE, as the setup page's Compose tab and the docs quickstart show it, and as the rebuild card renders
 * it again with the approved recipe. Its credentials come from the `.env` the platform's claim writes (CONNECT_TOKEN,
 * SANDBOX_GRANT, OWNER_EMAIL, INGRESS_URL, LOCAL_PORT); what is not secret is written into the file. */

// The platform's API origin (claim, announce): not the web app's, which answers a POST with 405.
export const PLATFORM_API_DEFAULT = "https://api.intentic.dev";

export interface SetupComposeArgs {
    // The sandbox's public hostname (<slug>.<zone>); its first label names the container and storage.
    readonly hostname: string;
    readonly image: string;
    // Empty makes GOOGLE_CLIENT_ID a variable that refuses to start, never an authorizer serving every route.
    readonly googleClientId: string;
    // The origin the editor is served from (WEB_ORIGIN), written only when it is not the hosted app's.
    readonly webOrigin: string;
    // Local dev only: the localhost platform origin; production leaves it undefined (PLATFORM_API_DEFAULT).
    readonly platformUrl?: string | undefined;
    // The rebuild card's: the approved recipe Compose builds, on storage that already exists.
    readonly recipe?: ComposeRecipe | undefined;
    readonly existingStorage?: boolean;
}

// What the claim's `.env` holds. The grant is required, the edge's URL optional (the daemon falls back to its default).
const CLAIMED: readonly EnvFileVar[] = [
    { name: "CONNECT_TOKEN", missing: MISSING_ENV },
    { name: "OWNER_EMAIL" },
    { name: "INGRESS_URL" },
    { name: "SANDBOX_GRANT", missing: MISSING_ENV },
];

// The dev logins volume every dev sandbox on a machine shares (connect.sh's INTENTIC_AGENT_AUTH_VOLUME).
const DEV_AGENT_AUTH_VOLUME = "intentic-dev-agent-auth";

// The host is not known where this file is written, so it carries no cgroup caps (`unmeasured`).
export const setupComposeFile = (args: SetupComposeArgs): string => {
    const dev = args.platformUrl !== undefined;
    // The platform as seen from the container (connect.sh's PLATFORM_URL_CONTAINER rewrite).
    const platform = (args.platformUrl ?? PLATFORM_API_DEFAULT).replace("//localhost", "//host.docker.internal").replace("//127.0.0.1", "//host.docker.internal");
    const env: [string, string][] = [
        ["SANDBOX_PUBLIC_URL", `https://${args.hostname}`],
        ["PLATFORM_URL", platform],
    ];
    const envFile: EnvFileVar[] = [...CLAIMED];
    if (args.googleClientId === "") {
        envFile.push({ name: "GOOGLE_CLIENT_ID", missing: "the web app did not supply a Google client id, reload the setup page" });
    } else {
        env.push(["GOOGLE_CLIENT_ID", args.googleClientId]);
    }
    // SPA origin for CORS: required for a self-hosted or local-dev editor, else its requests are refused.
    if (args.webOrigin !== PLATFORM_WEB_ORIGIN) {
        env.push(["WEB_ORIGIN", args.webOrigin]);
    }
    if (dev) {
        env.push(["AGENT_AUTH_DIR", AGENT_AUTH_ROOT]);
    }
    return sandboxCompose(
        {
            names: sandboxNames(slugOfHostname(args.hostname) ?? args.hostname),
            image: args.image,
            baseImage: args.image,
            env,
            // Fresh public resolvers: a just-minted tunnel hostname must not hit a stale NXDOMAIN cache.
            dns: ["1.1.1.1", "1.0.0.1"],
            mounts: dev ? [`${DEV_AGENT_AUTH_VOLUME}:${AGENT_AUTH_ROOT}`] : [],
        },
        { existingStorage: args.existingStorage === true, unmeasured: true, envFile, recipe: args.recipe },
    ).compose;
};
