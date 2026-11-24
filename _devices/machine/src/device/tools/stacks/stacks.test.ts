import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { DeviceStacksSchema, STACK_LOG_TAIL_DEFAULT, StackOpSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import { dockerAnswered, fakeDocker, grantWith } from "../../device-testing.js";
import { ScopeError } from "../../policy.js";
import {
    combinedStatus,
    COMPOSE_LS_ARGS,
    CONTAINERS_ARGS,
    CONTAINERS_FORMAT,
    deployArgs,
    dockerFailure,
    healthOf,
    listStacks,
    mergeStacks,
    parseComposeLs,
    parseContainers,
    stackAction,
    stackLogs,
    stackLogsArgs,
    stackOpArgs,
    stacksRoot,
} from "./stacks.js";

/* What `docker compose ls` and `docker ps` print, read and merged without a Docker engine, and the command lines the
   stack tools hand docker. The fixtures are in the shapes Docker 29 and Compose 5 print on a Linux server (`ps` through
   CONTAINERS_FORMAT), the names and paths changed. These paths are on no machine, so no compose file is ever found. */

const ROOT = "/home/me/.intentic/machine/stacks";

// `docker compose ls --all --format json`: one project deployed into the stacks folder from two files, one started by
// hand, one whose containers are gone but which compose still lists.
const COMPOSE_LS = JSON.stringify([
    { Name: "shop", Status: "exited(1), running(2)", ConfigFiles: `${ROOT}/shop/compose.yaml,${ROOT}/shop/compose.prod.yaml` },
    { Name: "notes", Status: "running(1)", ConfigFiles: "/home/me/notes/docker-compose.yml" },
    { Name: "ghost", Status: "exited(0)", ConfigFiles: "/srv/ghost/compose.yaml" },
]);

// `docker ps` through CONTAINERS_FORMAT, one line per container.
const row = (fields: Record<string, string>): string =>
    JSON.stringify({ container: "", image: "", state: "", status: "", project: "", service: "", workingDir: "", configFiles: "", kind: "", ...fields });
const shopFiles = `${ROOT}/shop/compose.yaml,${ROOT}/shop/compose.prod.yaml`;
const PS = [
    row({ container: "shop-web-1", image: "shop-web", state: "running", status: "Up 3 hours (healthy)", project: "shop", service: "web", workingDir: `${ROOT}/shop`, configFiles: shopFiles }),
    row({ container: "shop-db-1", image: "postgres:18.4-alpine3.24", state: "running", status: "Up 3 hours (health: starting)", project: "shop", service: "db", workingDir: `${ROOT}/shop`, configFiles: shopFiles }),
    row({ container: "shop-migrate-1", image: "shop-web", state: "exited", status: "Exited (0) 3 hours ago", project: "shop", service: "migrate", workingDir: `${ROOT}/shop`, configFiles: shopFiles }),
    row({ container: "notes-app-1", image: "ghcr.io/me/notes:2", state: "running", status: "Up 2 days (unhealthy)", project: "notes", service: "app", workingDir: "/home/me/notes", configFiles: "/home/me/notes/docker-compose.yml" }),
    // A project compose ls did not list: it started between the two reads.
    row({ container: "late-api-1", image: "late-api", state: "restarting", status: "Restarting (1) 4 seconds ago", project: "late", service: "api", workingDir: "/srv/late", configFiles: "/srv/late/compose.yaml" }),
    row({ container: "late-worker-1", image: "late-api", state: "frozen", status: "Frozen", project: "late", service: "worker", workingDir: "/srv/late", configFiles: "/srv/late/compose.yaml" }),
    // A sandbox's own helper, started through compose.
    row({ container: "intentic-dind-host-1", image: "docker:dind", state: "running", status: "Up 1 hour", project: "intentic-dind", service: "dind", workingDir: "/srv/dind", kind: "sandbox" }),
    // A project name compose would never make: it cannot be named back through the tools' arguments.
    row({ container: "Weird-1", image: "x", state: "running", status: "Up", project: "Weird Name", service: "x" }),
].join("\n");

test("docker is asked for every project and every compose container, each label read by name", () => {
    expect(COMPOSE_LS_ARGS).toEqual(["compose", "ls", "--all", "--format", "json"]);
    expect(CONTAINERS_FORMAT).toBe(
        '{"container":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},' +
            '"project":{{json (.Label "com.docker.compose.project")}},"service":{{json (.Label "com.docker.compose.service")}},' +
            '"workingDir":{{json (.Label "com.docker.compose.project.working_dir")}},' +
            '"configFiles":{{json (.Label "com.docker.compose.project.config_files")}},"kind":{{json (.Label "dev.intentic.kind")}}}',
    );
    expect(CONTAINERS_ARGS).toEqual(["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", CONTAINERS_FORMAT]);
});

test("compose ls is read with its comma-joined files split, and an empty engine in any of its spellings is no project", () => {
    expect(parseComposeLs(COMPOSE_LS)).toEqual([
        { name: "shop", status: "exited(1), running(2)", configFiles: [`${ROOT}/shop/compose.yaml`, `${ROOT}/shop/compose.prod.yaml`] },
        { name: "notes", status: "running(1)", configFiles: ["/home/me/notes/docker-compose.yml"] },
        { name: "ghost", status: "exited(0)", configFiles: ["/srv/ghost/compose.yaml"] },
    ]);
    expect(parseComposeLs("[]\n")).toEqual([]);
    expect(parseComposeLs("null")).toEqual([]);
    expect(parseComposeLs("")).toEqual([]);
    // A row with no name cannot be placed and is left out; the rest stands.
    expect(parseComposeLs('[{"Status":"running(1)"},{"Name":"a","Status":"running(1)","ConfigFiles":""}]')).toEqual([{ name: "a", status: "running(1)", configFiles: [] }]);
    expect(() => parseComposeLs("docker: 'compose' is not a docker command.")).toThrow(
        `docker compose ls answered with something other than what was asked for: "docker: 'compose' is not a docker command."`,
    );
});

test("a docker ps line in any other shape than the format asked for is a failure, not a container left out", () => {
    expect(parseContainers(`${PS}\n\n`)).toHaveLength(8);
    expect(() => parseContainers('{"ID":"afbfd4f98b32","Names":"x"}')).toThrow('docker ps answered with something other than what was asked for: "{\\"ID\\"');
});

test("the healthcheck's verdict is read out of Docker's status prose", () => {
    expect(healthOf("Up 3 hours (healthy)")).toBe("healthy");
    expect(healthOf("Up 2 days (unhealthy)")).toBe("unhealthy");
    expect(healthOf("Up 5 seconds (health: starting)")).toBe("starting");
    expect(healthOf("Up 3 hours")).toBeUndefined();
    expect(healthOf("Exited (0) 3 hours ago")).toBeUndefined();
});

test("a summary is built from container states the way compose ls builds its own", () => {
    expect(combinedStatus(["running", "exited", "running"])).toBe("exited(1), running(2)");
    expect(combinedStatus([])).toBe("");
});

test("every project either read names is a stack, sorted, with its services, and the answer is the contract's", () => {
    const merged = mergeStacks(ROOT, parseComposeLs(COMPOSE_LS), parseContainers(PS), "linux");
    expect(DeviceStacksSchema.parse(merged)).toEqual(merged);
    expect(merged).toEqual({
        root: ROOT,
        stacks: [
            { name: "ghost", status: "exited(0)", configFiles: ["/srv/ghost/compose.yaml"], managed: false, sandbox: false, services: [] },
            {
                name: "intentic-dind",
                status: "running(1)",
                configFiles: [],
                workingDir: "/srv/dind",
                managed: false,
                sandbox: true,
                services: [{ service: "dind", container: "intentic-dind-host-1", image: "docker:dind", state: "running", status: "Up 1 hour" }],
            },
            {
                name: "late",
                status: "frozen(1), restarting(1)",
                configFiles: ["/srv/late/compose.yaml"],
                workingDir: "/srv/late",
                managed: false,
                sandbox: false,
                services: [
                    { service: "api", container: "late-api-1", image: "late-api", state: "restarting", status: "Restarting (1) 4 seconds ago" },
                    { service: "worker", container: "late-worker-1", image: "late-api", state: "unknown", status: "Frozen" },
                ],
            },
            {
                name: "notes",
                status: "running(1)",
                configFiles: ["/home/me/notes/docker-compose.yml"],
                workingDir: "/home/me/notes",
                managed: false,
                sandbox: false,
                services: [{ service: "app", container: "notes-app-1", image: "ghcr.io/me/notes:2", state: "running", status: "Up 2 days (unhealthy)", health: "unhealthy" }],
            },
            {
                name: "shop",
                status: "exited(1), running(2)",
                configFiles: [`${ROOT}/shop/compose.yaml`, `${ROOT}/shop/compose.prod.yaml`],
                workingDir: `${ROOT}/shop`,
                managed: true,
                sandbox: false,
                services: [
                    { service: "db", container: "shop-db-1", image: "postgres:18.4-alpine3.24", state: "running", status: "Up 3 hours (health: starting)", health: "starting" },
                    { service: "migrate", container: "shop-migrate-1", image: "shop-web", state: "exited", status: "Exited (0) 3 hours ago" },
                    { service: "web", container: "shop-web-1", image: "shop-web", state: "running", status: "Up 3 hours (healthy)", health: "healthy" },
                ],
            },
        ],
    });
});

test("managed means run from a folder strictly inside the stacks root, by the rules of the platform that recorded it", () => {
    const at = (workingDir: string, root: string, platform: NodeJS.Platform): boolean =>
        mergeStacks(root, [], parseContainers(row({ container: "a-1", state: "running", project: "a", workingDir })), platform).stacks[0]?.managed ?? false;
    expect(at(`${ROOT}/a`, ROOT, "linux")).toBe(true);
    expect(at(`${ROOT}/a/deploy`, ROOT, "linux")).toBe(true);
    expect(at(ROOT, ROOT, "linux")).toBe(false);
    expect(at(`${ROOT}-old/a`, ROOT, "linux")).toBe(false);
    expect(at(`${ROOT}/../a`, ROOT, "linux")).toBe(false);
    const windowsRoot = "C:\\Users\\me\\.intentic\\machine\\stacks";
    expect(at("c:\\users\\me\\.intentic\\machine\\stacks\\a", windowsRoot, "win32")).toBe(true);
    expect(at("D:\\stacks\\a", windowsRoot, "win32")).toBe(false);
});

test("each op is one closed command line, and none of them takes a stack down or deletes a volume", () => {
    const files = ["/srv/a/compose.yaml", "/srv/a/compose.prod.yaml"] as const;
    const base = ["compose", "-p", "a", "-f", files[0], "-f", files[1]];
    expect(stackOpArgs("a", "up", files)).toEqual([[...base, "up", "-d", "--remove-orphans"]]);
    expect(stackOpArgs("a", "pull", files)).toEqual([
        [...base, "pull"],
        [...base, "up", "-d", "--remove-orphans"],
    ]);
    expect(stackOpArgs("a", "restart", [])).toEqual([["compose", "-p", "a", "restart"]]);
    expect(stackOpArgs("a", "start", [])).toEqual([["compose", "-p", "a", "start"]]);
    expect(stackOpArgs("a", "stop", files)).toEqual([[...base, "stop"]]);
    expect(stackLogsArgs("a", 200, files)).toEqual([...base, "logs", "--no-color", "--tail", "200"]);
    expect(deployArgs("a", "/home/me/.intentic/machine/stacks/a/compose.yaml")).toEqual([
        "compose",
        "-p",
        "a",
        "-f",
        "/home/me/.intentic/machine/stacks/a/compose.yaml",
        "up",
        "-d",
        "--build",
        "--remove-orphans",
    ]);
    const words = StackOpSchema.options.flatMap((op) => stackOpArgs("a", op, files).flat());
    expect(words.filter((word) => ["down", "rm", "kill", "-v", "--volumes", "--rmi"].includes(word))).toEqual([]);
});

test("a docker that is not there, one stopped before it finished, and a failed run are each said in words", () => {
    expect(dockerFailure("docker compose ls", { status: null, stdout: "", stderr: "spawn docker ENOENT", spawnCode: "ENOENT" }, 25_000)).toBe(
        "Docker is not installed on this device, or docker is not on the agent's PATH: spawn docker ENOENT",
    );
    expect(dockerFailure("docker compose up", { status: null, stdout: "", stderr: " Image pulling" }, 600_000)).toBe(
        "docker compose up did not finish: it was stopped at its 600 s deadline, or by a signal, with everything it started.\n\n Image pulling",
    );
    expect(dockerFailure("docker compose up", { status: 1, stdout: "", stderr: "service \"web\" refers to undefined volume data\n" }, 600_000, "web Pulled")).toBe(
        'docker compose up failed (exit 1).\n\nweb Pulled\nservice "web" refers to undefined volume data',
    );
});

const off: DeviceScopes = grantWith();
const shell: DeviceScopes = { ...off, shell: "on" };

test("the listing needs 'Run commands', and answers the contract's JSON with the stacks root", async () => {
    await expect(listStacks(off, fakeDocker({}).docker)).rejects.toBeInstanceOf(ScopeError);
    const { docker } = fakeDocker({ ls: dockerAnswered(COMPOSE_LS), ps: dockerAnswered(PS) });
    const answer = DeviceStacksSchema.parse(JSON.parse(await listStacks(shell, docker)));
    expect(answer.root).toBe(stacksRoot());
    expect(answer.stacks.map((stack) => stack.name)).toEqual(["ghost", "intentic-dind", "late", "notes", "shop"]);
});

test("a docker that is missing or fails is an error in its own words, never an empty list", async () => {
    const missing = fakeDocker({ ls: { status: null, stdout: "", stderr: "spawn docker ENOENT", spawnCode: "ENOENT" } });
    await expect(listStacks(shell, missing.docker)).rejects.toThrow("Docker is not installed on this device, or docker is not on the agent's PATH: spawn docker ENOENT");
    const down = fakeDocker({ ps: { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n" } });
    await expect(listStacks(shell, down.docker)).rejects.toThrow(
        "docker ps failed (exit 1).\n\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
});

test("stack_action refuses a name it cannot find and a sandbox's own project, before compose is asked anything", async () => {
    const { calls, docker } = fakeDocker({ ls: dockerAnswered(COMPOSE_LS), ps: dockerAnswered(PS) });
    await expect(stackAction("nope", "restart", shell, docker)).rejects.toThrow('There is no compose stack called "nope" on this device; list_stacks names them.');
    await expect(stackAction("intentic-dind", "stop", shell, docker)).rejects.toThrow(
        '"intentic-dind" belongs to an Intentic sandbox on this device: the Devices view drives sandboxes (manage_sandbox), not stack_action.',
    );
    await expect(stackAction("shop", "stop", off, docker)).rejects.toBeInstanceOf(ScopeError);
    expect(calls.filter((call) => call.args[0] === "compose" && call.args[1] === "-p")).toEqual([]);
});

test("up and pull need the files compose started a stack from; start, stop and restart run on its containers without them", async () => {
    // ghost's file is not on this disk, and its working folder is gone.
    const { calls, docker } = fakeDocker({ ls: dockerAnswered(COMPOSE_LS), ps: dockerAnswered(PS), compose: dockerAnswered("", " Container ghost-1  Restarting\n Container ghost-1  Started\n") });
    await expect(stackAction("ghost", "up", shell, docker)).rejects.toThrow(
        '"ghost" was started from compose files that are gone (/srv/ghost/compose.yaml), so `up` cannot run on it: start, stop and restart still work on its containers as they are. Deploy it again, or bring it up from its own folder.',
    );
    await expect(stackAction("ghost", "pull", shell, docker)).rejects.toThrow("so `pull` cannot run on it");
    expect(await stackAction("ghost", "restart", shell, docker)).toBe(" Container ghost-1  Restarting\n Container ghost-1  Started");
    expect(calls.at(-1)).toEqual({ args: ["compose", "-p", "ghost", "restart"], cwd: undefined });
});

test("stack_logs reads the tail compose keeps, by default the contract's", async () => {
    const { calls, docker } = fakeDocker({ ls: dockerAnswered(COMPOSE_LS), ps: dockerAnswered(PS), compose: dockerAnswered("notes-app-1  | listening on :8080\n") });
    await expect(stackLogs("notes", undefined, off, docker)).rejects.toBeInstanceOf(ScopeError);
    expect(await stackLogs("notes", undefined, shell, docker)).toBe("notes-app-1  | listening on :8080\n");
    expect(calls.at(-1)?.args).toEqual(["compose", "-p", "notes", "logs", "--no-color", "--tail", String(STACK_LOG_TAIL_DEFAULT)]);
    await stackLogs("notes", 40, shell, docker);
    expect(calls.at(-1)?.args.slice(-2)).toEqual(["--tail", "40"]);
});
