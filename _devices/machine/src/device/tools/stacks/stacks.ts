import { stat } from "node:fs/promises";
import { join } from "node:path";
import { insideRel } from "@intentic/base/contained";
import { parseJsonWith } from "@intentic/base/json";
import { clipText } from "@intentic/base/process";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    type DeployStackToolArgs,
    DeployStackToolArgsSchema,
    type DeviceStack,
    type DeviceStacks,
    STACK_LOG_TAIL_DEFAULT,
    STACK_LOG_TAIL_MAX,
    type StackContainerState,
    StackContainerStateSchema,
    StackNameSchema,
    type StackOp,
    StackOpSchema,
    type StackService,
} from "@intentic/sandbox-contract/schemas/device-stacks";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { baseDir } from "../../../config.js";
import { type ExecResult, runProcess } from "../../../sync/exec.js";
import { assertScope } from "../../policy.js";
import { composeFileIn, copyIntoStack, recordDeploy, stagedSource } from "./stack-folder.js";

/* DOCKER COMPOSE STACKS ON THIS MACHINE (schemas/device-stacks.ts), for the Deployments board's own backend: a server
   the owner paired is deployed to over the link this agent already holds, with no second agent (a Komodo Periphery)
   beside it. The agent runs `docker compose` itself, against the engine every docker it spawns reaches (engine-env.ts),
   and checks its own switches: reading and driving a stack is "Run commands"; a deploy also runs what the sandbox sent,
   so it needs "Run programs this sandbox sends" too. Nothing here takes a stack down or deletes a volume: the ops are a
   closed list, and `down`, `rm` and `-v` are the owner's to run by hand. */

// Where a deployed stack lives, `<root>/<name>`: beside the agent's other state, and kept by `uninstall --purge` as the
// person's data (uninstall/plan.ts), since a service's bind-mounted data may be in it.
export const stacksRoot = (): string => join(baseDir, "stacks");

// How docker is run: the agent's one bounded runner, which inherits the Intentic engine's environment, or a test's fake.
export type Docker = (args: readonly string[], options: { readonly cwd?: string | undefined; readonly timeoutMs: number }) => Promise<ExecResult>;
const machineDocker: Docker = async (args, options) => await runProcess("docker", args, options);

// A listing is two reads of the engine's own state, seconds even on a loaded machine. The daemon waits a minute for a
// read (_sandbox/sandbox hosts/stacks/device-stacks.ts), and the logs are a lookup and then a read, so each stays well under half of that.
const READ_TIMEOUT_MS = 25_000;
// A pull, or an `up` that builds an image a service names, takes minutes on a home connection. Ten minutes for the
// whole op (a pull and the up after it share them), as long as any device command runs (run_command's longest).
const STACK_OP_TIMEOUT_MS = 10 * 60_000;
// A deploy's `up --build` builds every image the stack names: the same ten minutes, inside the hub's own ceiling.
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
// What compose printed, kept to a size an answer carries: its start says what it did, its end how it ended.
const MAX_OUTPUT_CHARS = 200_000;

const PROJECT_LABEL = "com.docker.compose.project";

// Each container as one JSON object, every label read by name. `{{json .}}` gives the labels as one "k=v,k=v" string,
// which a project of several compose files makes ambiguous: compose joins their paths with commas in its label.
const CONTAINER_FIELDS = {
    container: ".Names",
    image: ".Image",
    state: ".State",
    status: ".Status",
    project: `(.Label "${PROJECT_LABEL}")`,
    service: '(.Label "com.docker.compose.service")',
    workingDir: '(.Label "com.docker.compose.project.working_dir")',
    configFiles: '(.Label "com.docker.compose.project.config_files")',
    // Set on every container ic makes for a sandbox (_sandbox/ic/src/sandbox/labels.rs).
    kind: '(.Label "dev.intentic.kind")',
} as const;
export const CONTAINERS_FORMAT = `{${Object.entries(CONTAINER_FIELDS)
    .map(([key, field]) => `"${key}":{{json ${field}}}`)
    .join(",")}}`;

export const COMPOSE_LS_ARGS: readonly string[] = ["compose", "ls", "--all", "--format", "json"];
export const CONTAINERS_ARGS: readonly string[] = ["ps", "-a", "--filter", `label=${PROJECT_LABEL}`, "--format", CONTAINERS_FORMAT];

const ComposeLsRowSchema = z.object({ Name: z.string(), Status: z.string().catch(""), ConfigFiles: z.string().catch("") });

const ContainerRowSchema = z.object({
    container: z.string(),
    image: z.string().catch(""),
    state: z.string().catch(""),
    status: z.string().catch(""),
    project: z.string(),
    service: z.string().catch(""),
    workingDir: z.string().catch(""),
    configFiles: z.string().catch(""),
    kind: z.string().catch(""),
});
export type ContainerRow = z.infer<typeof ContainerRowSchema>;

export interface ComposeProject {
    readonly name: string;
    readonly status: string;
    readonly configFiles: readonly string[];
}

// Compose joins a project's files with commas, in `ls` and in its label alike.
const splitFiles = (joined: string): string[] =>
    joined
        .split(",")
        .map((file) => file.trim())
        .filter((file) => file !== "");

// Docker's JSON read as what was asked for, or a failure quoting what came instead: an empty listing in its place would
// say there is nothing on this machine.
const readJson = <T>(what: string, text: string, schema: z.ZodType<T>): T => {
    const value = parseJsonWith(text, schema);
    if (value === undefined) {
        throw new Error(`${what} answered with something other than what was asked for: ${JSON.stringify(text.slice(0, 300))}`);
    }
    return value;
};

// `docker compose ls --format json` is one JSON array; an engine with no project is `[]`, which some releases print as
// nothing or `null`. A row without a name is one this reading cannot place, and is left out rather than failing the rest.
const ComposeLsAnswerSchema = z.array(z.unknown()).nullable();
export const parseComposeLs = (stdout: string): ComposeProject[] => {
    const text = stdout.trim();
    const rows = text === "" ? [] : (readJson("docker compose ls", text, ComposeLsAnswerSchema) ?? []);
    return rows.flatMap((row) => {
        const read = ComposeLsRowSchema.safeParse(row);
        return read.success ? [{ name: read.data.Name, status: read.data.Status, configFiles: splitFiles(read.data.ConfigFiles) }] : [];
    });
};

// One object per line, as CONTAINERS_FORMAT prints them; a line of any other shape means the format was not applied.
export const parseContainers = (stdout: string): ContainerRow[] =>
    stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => readJson("docker ps", line, ContainerRowSchema))
        .filter((row) => row.project !== "");

// Docker's own state words; one a newer engine says that the contract does not know is `unknown`, not a failed listing.
const stateOf = (state: string): StackContainerState => {
    const known = StackContainerStateSchema.safeParse(state.toLowerCase());
    return known.success ? known.data : "unknown";
};

// The healthcheck's verdict as Docker's status prose carries it: "Up 3 hours (healthy)", "Up 5 seconds (health: starting)".
const HEALTH: readonly (readonly [RegExp, NonNullable<StackService["health"]>])[] = [
    [/\(healthy\)/, "healthy"],
    [/\(unhealthy\)/, "unhealthy"],
    [/\(health: starting\)/, "starting"],
];
export const healthOf = (status: string): StackService["health"] => HEALTH.find(([said]) => said.test(status))?.[1];

const serviceOf = (row: ContainerRow): StackService => {
    const health = healthOf(row.status);
    // `.Names` lists a container's legacy link aliases after its own name.
    const container = row.container.split(",")[0] ?? row.container;
    const service: StackService = { service: row.service === "" ? container : row.service, container, image: row.image, state: stateOf(row.state), status: row.status };
    if (health !== undefined) {
        service.health = health;
    }
    return service;
};

// Compose's summary for a project `ls` did not list, built as `ls` builds it (compose's combinedStatus): each state with
// how many containers are in it, the states in alphabetical order.
export const combinedStatus = (states: readonly string[]): string => {
    const counts = new Map<string, number>();
    for (const state of states) {
        counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return [...counts]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([state, count]) => `${state}(${count})`)
        .join(", ");
};

// Strictly inside: a project run from the root itself is no deployed stack. Lexical, on the path as compose recorded it,
// under the rules of the platform that recorded it.
const insideRoot = (root: string, workingDir: string, platform: NodeJS.Platform): boolean => {
    const rel = insideRel(root, workingDir, { platform, foldCase: platform === "darwin" });
    return rel !== undefined && rel !== "";
};

const stackOf = (root: string, name: string, listed: ComposeProject | undefined, rows: readonly ContainerRow[], platform: NodeJS.Platform): DeviceStack => {
    const workingDir = rows.find((row) => row.workingDir !== "")?.workingDir;
    const labelled = splitFiles(rows.find((row) => row.configFiles !== "")?.configFiles ?? "");
    const stack: DeviceStack = {
        name,
        status: listed !== undefined && listed.status !== "" ? listed.status : combinedStatus(rows.map((row) => row.state)),
        configFiles: listed !== undefined && listed.configFiles.length > 0 ? [...listed.configFiles] : labelled,
        managed: workingDir !== undefined && insideRoot(root, workingDir, platform),
        sandbox: rows.some((row) => row.kind !== ""),
        services: rows.map(serviceOf).toSorted((a, b) => a.service.localeCompare(b.service) || a.container.localeCompare(b.container)),
    };
    if (workingDir !== undefined) {
        stack.workingDir = workingDir;
    }
    return stack;
};

// Every project either read names: one `ls` lists with no container left still shows, with no services; containers of
// a project `ls` did not list (it changed between the two reads) still show, their summary built from their states.
export const mergeStacks = (
    root: string,
    projects: readonly ComposeProject[],
    containers: readonly ContainerRow[],
    platform: NodeJS.Platform = process.platform,
): DeviceStacks => {
    const listed = new Map(projects.map((project) => [project.name, project]));
    const stacks = [...new Set([...listed.keys(), ...containers.map((row) => row.project)])]
        // A name compose itself would not make cannot be named back to it through these tools' arguments.
        .filter((name) => StackNameSchema.safeParse(name).success)
        .toSorted((a, b) => a.localeCompare(b))
        .map((name) =>
            stackOf(
                root,
                name,
                listed.get(name),
                containers.filter((row) => row.project === name),
                platform,
            ),
        );
    return { root, stacks };
};

// Everything a run printed, stdout then stderr: compose writes its progress to stderr.
const outputOf = (result: ExecResult): string =>
    [result.stdout, result.stderr]
        .map((text) => text.trimEnd())
        .filter((text) => text !== "")
        .join("\n");

const clipped = (text: string): string => clipText(text, MAX_OUTPUT_CHARS).text;

// Why a docker run gave no answer, in words: no docker here, a run stopped before it finished, or its own exit with
// what it printed. `earlier` is what the steps before it printed, so a failed `up` after a pull keeps the pull's output.
export const dockerFailure = (what: string, result: ExecResult, timeoutMs: number, earlier = ""): string => {
    if (result.spawnCode === "ENOENT") {
        return `Docker is not installed on this device, or docker is not on the agent's PATH: ${result.stderr.trim()}`;
    }
    const output = [earlier, outputOf(result)].filter((text) => text !== "").join("\n");
    const said = output === "" ? "" : `\n\n${clipped(output)}`;
    return result.status === null
        ? `${what} did not finish: it was stopped at its ${Math.round(timeoutMs / 1000)} s deadline, or by a signal, with everything it started.${said}`
        : `${what} failed (exit ${result.status}).${said}`;
};

const answered = (what: string, result: ExecResult, timeoutMs: number): string => {
    if (result.status !== 0) {
        throw new Error(dockerFailure(what, result, timeoutMs));
    }
    return result.stdout;
};

const readStacks = async (docker: Docker = machineDocker): Promise<DeviceStacks> => {
    const [ls, ps] = await Promise.all([docker(COMPOSE_LS_ARGS, { timeoutMs: READ_TIMEOUT_MS }), docker(CONTAINERS_ARGS, { timeoutMs: READ_TIMEOUT_MS })]);
    const projects = parseComposeLs(answered("docker compose ls", ls, READ_TIMEOUT_MS));
    return mergeStacks(stacksRoot(), projects, parseContainers(answered("docker ps", ps, READ_TIMEOUT_MS)));
};

export const listStacks = async (scopes: DeviceScopes, docker: Docker = machineDocker): Promise<string> => {
    assertScope(scopes, "shell");
    return JSON.stringify(await readStacks(docker));
};

const findStack = async (name: string, docker: Docker): Promise<DeviceStack> => {
    const found = (await readStacks(docker)).stacks.find((stack) => stack.name === name);
    if (found === undefined) {
        throw new Error(`There is no compose stack called "${name}" on this device; list_stacks names them.`);
    }
    return found;
};

// The stack's compose files when every one is still on this disk: compose refuses a missing `-f` outright, and a
// project started from files since deleted (or from the other side of a WSL boundary) still runs.
const filesOnDisk = async (files: readonly string[]): Promise<readonly string[] | undefined> => {
    // allow(silent-catch): a file that cannot be read here is one compose could not read either
    const present = await Promise.all(files.map(async (file) => (await stat(file).catch(() => undefined))?.isFile() === true));
    return files.length > 0 && present.every(Boolean) ? files : undefined;
};

// The folder compose recorded, when it is still there: a working directory that is gone fails the spawn itself, with an
// ENOENT that would read as docker missing.
const existingDir = async (dir: string | undefined): Promise<string | undefined> =>
    // allow(silent-catch): a folder that cannot be read is no folder to run in, and compose runs without one
    dir !== undefined && (await stat(dir).catch(() => undefined))?.isDirectory() === true ? dir : undefined;

// `docker compose` aimed at one project by its name, with its files where they are known.
const composeArgs = (name: string, files: readonly string[]): string[] => ["compose", "-p", name, ...files.flatMap((file) => ["-f", file])];

// What each op runs, in order. `up` (and the pull's `up`) applies the files as they are and removes the containers of
// services no longer in them; nothing here runs `down`, `rm` or anything with `-v`.
const OP_COMMANDS = {
    up: [["up", "-d", "--remove-orphans"]],
    pull: [["pull"], ["up", "-d", "--remove-orphans"]],
    restart: [["restart"]],
    start: [["start"]],
    stop: [["stop"]],
} as const satisfies Readonly<Record<StackOp, readonly (readonly string[])[]>>;
const NEEDS_FILES: ReadonlySet<StackOp> = new Set(["up", "pull"]);

export const stackOpArgs = (name: string, op: StackOp, files: readonly string[]): string[][] =>
    OP_COMMANDS[op].map((command) => [...composeArgs(name, files), ...command]);

export const stackLogsArgs = (name: string, tail: number, files: readonly string[]): string[] => [
    ...composeArgs(name, files),
    "logs",
    "--no-color",
    "--tail",
    String(tail),
];

export const deployArgs = (name: string, composeFile: string): string[] => [...composeArgs(name, [composeFile]), "up", "-d", "--build", "--remove-orphans"];

// One change to a stack at a time: two deploys of one name copying into one folder, or a stop racing an up, would each
// leave whatever the other half did.
const turns = new Map<string, Promise<void>>();
const oneAtATime = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const turn = (turns.get(name) ?? Promise.resolve()).then(work);
    const settled = turn.then(
        () => undefined,
        () => undefined,
    );
    turns.set(name, settled);
    try {
        return await turn;
    } finally {
        if (turns.get(name) === settled) {
            turns.delete(name);
        }
    }
};

// The steps of one op, sharing one deadline, stopped at the first that fails with everything printed so far.
const runSteps = async (steps: readonly (readonly string[])[], cwd: string | undefined, docker: Docker, what: string): Promise<string> => {
    const deadline = Date.now() + STACK_OP_TIMEOUT_MS;
    const printed: string[] = [];
    for (const args of steps) {
        // in order: the `up` after a pull applies what the pull fetched
        const result = await docker(args, { cwd, timeoutMs: Math.max(deadline - Date.now(), 1_000) });
        if (result.status !== 0) {
            throw new Error(dockerFailure(what, result, STACK_OP_TIMEOUT_MS, printed.join("\n")));
        }
        const output = outputOf(result);
        if (output !== "") {
            printed.push(output);
        }
    }
    return clipped(printed.join("\n"));
};

export const stackAction = async (name: string, op: StackOp, scopes: DeviceScopes, docker: Docker = machineDocker): Promise<string> => {
    assertScope(scopes, "shell");
    return await oneAtATime(name, async () => {
        const stack = await findStack(name, docker);
        if (stack.sandbox) {
            throw new Error(`"${name}" belongs to an Intentic sandbox on this device: the Devices view drives sandboxes (manage_sandbox), not stack_action.`);
        }
        const files = await filesOnDisk(stack.configFiles);
        if (files === undefined && NEEDS_FILES.has(op)) {
            const which =
                stack.configFiles.length === 0
                    ? `Compose no longer knows the files "${name}" was started from`
                    : `"${name}" was started from compose files that are gone (${stack.configFiles.join(", ")})`;
            throw new Error(
                `${which}, so \`${op}\` cannot run on it: start, stop and restart still work on its containers as they are. Deploy it again, or bring it up from its own folder.`,
            );
        }
        return await runSteps(stackOpArgs(name, op, files ?? []), await existingDir(stack.workingDir), docker, `docker compose ${op} for ${name}`);
    });
};

// The end of the logs, which is what was asked for; a cut is said where it is.
const lastOf = (text: string): string =>
    text.length <= MAX_OUTPUT_CHARS ? text : `… [${text.length - MAX_OUTPUT_CHARS} characters cut] …\n${text.slice(-MAX_OUTPUT_CHARS)}`;

export const stackLogs = async (name: string, tail: number | undefined, scopes: DeviceScopes, docker: Docker = machineDocker): Promise<string> => {
    assertScope(scopes, "shell");
    const stack = await findStack(name, docker);
    const files = (await filesOnDisk(stack.configFiles)) ?? [];
    const args = stackLogsArgs(name, tail ?? STACK_LOG_TAIL_DEFAULT, files);
    const result = await docker(args, { cwd: await existingDir(stack.workingDir), timeoutMs: READ_TIMEOUT_MS });
    return lastOf(answered(`docker compose logs for ${name}`, result, READ_TIMEOUT_MS));
};

// A project of this name that no deploy put in the stacks folder is somebody else's: an `up --remove-orphans` under its
// name would replace its containers with the repository's and remove the rest. One with no container left has nothing
// to replace.
const refuseTakeover = (existing: DeviceStack | undefined): void => {
    if (existing === undefined || existing.managed) {
        return;
    }
    if (existing.sandbox) {
        throw new Error(`"${existing.name}" is an Intentic sandbox's own compose project on this device: deploy under another name.`);
    }
    if (existing.workingDir !== undefined) {
        throw new Error(
            `A compose project called "${existing.name}" already runs on this device from ${existing.workingDir}, which no deploy put there: deploying under its name would replace its containers. Deploy under another name.`,
        );
    }
};

export const deployStack = async (args: DeployStackToolArgs, scopes: DeviceScopes, sandboxUrl: string, docker: Docker = machineDocker): Promise<string> => {
    assertScope(scopes, "shell");
    assertScope(scopes, "programs");
    const source = await stagedSource(args.source, sandboxUrl);
    // Checked before the stack's folder is touched, so a wrong name changes nothing there.
    await composeFileIn(source, args.composeFile, "the pushed repository");
    return await oneAtATime(args.name, async () => {
        refuseTakeover((await readStacks(docker)).stacks.find((stack) => stack.name === args.name));
        const dir = join(stacksRoot(), args.name);
        await copyIntoStack(source, dir);
        await recordDeploy(dir, { commit: args.commit, composeFile: args.composeFile, deployedAt: new Date().toISOString() });
        const composeFile = await composeFileIn(dir, args.composeFile, "the stack's folder");
        const result = await docker(deployArgs(args.name, composeFile), { cwd: dir, timeoutMs: DEPLOY_TIMEOUT_MS });
        if (result.status !== 0) {
            throw new Error(dockerFailure(`docker compose up for ${args.name} in ${dir}`, result, DEPLOY_TIMEOUT_MS));
        }
        return JSON.stringify({ path: dir, output: clipped(outputOf(result)) });
    });
};

// The four tools as the device serves them; `caller` is the sandbox the call came from, whose pushed builds alone a
// deploy may copy.
export const stackTools = (caller: () => string): McpTool<DeviceScopes>[] => [
    tool({
        name: "list_stacks",
        description:
            "The Docker compose stacks on this device, as JSON: `root`, the folder deploy_stack puts stacks in, and for each compose project, running or stopped, its name, compose's status, the compose files it was started from, its working folder, whether a deploy put it in `root` (`managed`), whether it is an Intentic sandbox's own (`sandbox`: list_sandboxes and manage_sandbox drive those, not these tools), and each service's container, image, state, status and health. Reads `docker compose ls` and `docker ps` and changes nothing. A device without Docker, or whose Docker does not answer, is an error in Docker's own words, never an empty list. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await listStacks(scopes)),
    }),
    tool({
        name: "stack_action",
        description:
            "Drive one compose stack on this device by its name from list_stacks, and answer with what compose printed. `up` applies its compose files as they are (`docker compose up -d --remove-orphans`, which also removes the containers of services no longer in them), `pull` fetches newer images and then does the same, `restart`, `start` and `stop` act on its containers. `up` and `pull` need the compose files the stack was started from and are refused once those are gone; an Intentic sandbox's own project is refused, since manage_sandbox drives those. Nothing here takes a stack down or deletes a volume: `down` and `-v` are the owner's to run. Requires the 'Run commands' permission.",
        effect: "write",
        input: z.object({
            name: StackNameSchema.describe("The stack's name, from list_stacks."),
            op: StackOpSchema.describe("up, pull (newer images, then up), restart, start or stop."),
        }),
        run: async ({ name, op }, scopes) => textResult(await stackAction(name, op, scopes)),
    }),
    tool({
        name: "stack_logs",
        description:
            "The end of one compose stack's logs on this device, every service's lines together (`docker compose logs --tail`), by its name from list_stacks. Read-only. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({
            name: StackNameSchema.describe("The stack's name, from list_stacks."),
            tail: z
                .int()
                .positive()
                .max(STACK_LOG_TAIL_MAX)
                .optional()
                .describe(`How many lines from the end of each service's log. Default ${STACK_LOG_TAIL_DEFAULT}, maximum ${STACK_LOG_TAIL_MAX}.`),
        }),
        run: async ({ name, tail }, scopes) => textResult(await stackLogs(name, tail, scopes)),
    }),
    tool({
        name: "deploy_stack",
        description:
            "Deploy a repository this sandbox pushed to this device as a compose stack: copy the pushed folder (`source`, the path the push answered with; any other folder is refused) into `<root>/<name>` (root from list_stacks), record the commit there in .intentic-deploy.json, and run `docker compose -p <name> -f <composeFile> up -d --build --remove-orphans` in that folder, for up to ten minutes. The copy adds and overwrites files and deletes nothing already in the folder (a service's data may live there); a .env is never copied, and one already there is never touched, so the secrets put there stay. A path whose kind differs between the folder and the repository, or a name another compose project on this device already runs under, is refused before anything is written. Answers with JSON: `path`, the stack's folder, and `output`, what compose printed; a failed `up` is an error carrying compose's output. Requires the 'Run commands' and 'Run programs this sandbox sends' permissions.",
        effect: "write",
        input: DeployStackToolArgsSchema,
        run: async (args, scopes) => textResult(await deployStack(args, scopes, caller())),
    }),
];
