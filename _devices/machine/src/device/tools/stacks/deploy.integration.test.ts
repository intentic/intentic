import { mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync, existsSync,mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { type DeployStackToolArgs, DeployStackToolResultSchema, DeviceStacksSchema, StackHealthSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import { dockerAnswered, fakeDeploySeams, fakeDocker, grantWith } from "../../device-testing.js";
import { ScopeError } from "../../policy.js";
import { sandboxRunsDir } from "../programs/artifacts.js";
import { COMPLETE } from "../programs/builds.js";
import { CONTAINER_IMAGE_FORMAT, IMAGE_DIGESTS_FORMAT } from "./deploy-health.js";
import { deployStack } from "./deploy.js";
import { DEPLOY_RECORD, readDeployRecord, STACK_STATE_DIR } from "./stack-folder.js";
import { envDigestOf } from "./stack-state.js";
import { listStacks, stackAction, stackLogs, stacksRoot } from "./stacks.js";

// Managed deploys (deploy_stack's `stacks-managed` fields) on real folders: `suites` gives this run a throwaway HOME, so
// the runs folder and the stacks root are temp ones. Docker, the hooks, the URLs and the clock are fakes
// (device-testing.ts); nothing here needs an engine, and a health wait of minutes runs at once. POSIX paths and modes.

const SANDBOX = "https://sandbox-0a1b2c3d4e5f.example.dev";
const OTHER = "https://sandbox-ffffffffffff.example.dev";
const COMMIT = "3f2a9c1e".repeat(5);
const granted: DeviceScopes = { ...grantWith(), shell: "on", programs: "on" };

const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
};

// A repository as a push files it for `sandboxUrl`, its marker written last (programs/artifacts.ts), under a name of its
// own: stacks.integration.test.ts files its pushes in the same runs folder.
let pushes = 0;
const pushed = (files: Readonly<Record<string, string>> = { "compose.yaml": "services: { web: { image: 'ghcr.io/me/web:main' } }\n" }, sandboxUrl = SANDBOX): string => {
    pushes += 1;
    const dir = join(sandboxRunsDir(sandboxUrl), "stack-managed", pushes.toString(16).padStart(12, "0"));
    for (const [path, text] of Object.entries(files)) {
        write(join(dir, path), text);
    }
    writeFileSync(join(dir, COMPLETE), "sha256\n");
    return dir;
};

const args = (name: string, source: string, managed: Partial<DeployStackToolArgs> = {}): DeployStackToolArgs => ({
    source,
    name,
    composeFile: "compose.yaml",
    commit: COMMIT,
    ...managed,
});

const answerOf = (text: string) => DeployStackToolResultSchema.parse(JSON.parse(text));
const mode = (path: string): number => statSync(path).mode & 0o777;
const composeRuns = (calls: ReturnType<typeof fakeDocker>["calls"]) => calls.filter((call) => call.args[0] === "compose" && call.args[1] === "-p");

// One container line as `docker ps` prints it through CONTAINERS_FORMAT.
const container = (fields: Readonly<Record<string, string>>): string =>
    JSON.stringify({ container: "", image: "", state: "running", status: "Up 1 minute", project: "", service: "", workingDir: "", configFiles: "", kind: "", ...fields });

test("every deploy records the sandbox that made it; another sandbox's deploy, op and logs are refused, and a stack from before owners is claimed", async () => {
    const dir = join(stacksRoot(), "owned");
    const { docker } = fakeDocker();
    await deployStack(args("owned", pushed()), granted, SANDBOX, docker);
    expect((await readDeployRecord(dir))?.owner).toBe(SANDBOX);

    write(join(dir, "data", "keep.txt"), "the stack's data");
    const theirs = pushed({ "compose.yaml": "services: { evil: {} }\n", "data/keep.txt": "overwritten" }, OTHER);
    const refused = await deployStack(args("owned", theirs), granted, OTHER, docker).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ScopeError);
    expect(String(refused)).toContain(`"owned" on this device was deployed by another sandbox (${SANDBOX}): only that sandbox may deploy it, drive it or read its logs.`);
    expect(readFileSync(join(dir, "data", "keep.txt"), "utf8")).toBe("the stack's data");
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain("ghcr.io/me/web:main");

    // The listing names the owner, and ops and logs from any other sandbox are refused before compose is asked.
    const listed = fakeDocker({ ps: dockerAnswered(container({ container: "owned-web-1", project: "owned", service: "web", workingDir: dir })) });
    const mine = DeviceStacksSchema.parse(JSON.parse(await listStacks(granted, SANDBOX, listed.docker)));
    expect(mine.stacks.find((stack) => stack.name === "owned")?.owner).toEqual({ sandbox: SANDBOX, you: true });
    const seen = DeviceStacksSchema.parse(JSON.parse(await listStacks(granted, OTHER, listed.docker)));
    expect(seen.stacks.find((stack) => stack.name === "owned")?.owner).toEqual({ sandbox: SANDBOX, you: false });
    await expect(stackAction("owned", "restart", granted, OTHER, listed.docker)).rejects.toThrow("was deployed by another sandbox");
    await expect(stackLogs("owned", undefined, granted, OTHER, listed.docker)).rejects.toThrow("was deployed by another sandbox");
    expect(composeRuns(listed.calls)).toEqual([]);
    expect(await stackAction("owned", "restart", granted, SANDBOX, listed.docker)).toBe(" Container a-1  Started");

    // A record written before owners were: the next deploy, whoever's, claims the stack.
    write(join(dir, DEPLOY_RECORD), JSON.stringify({ commit: COMMIT, composeFile: "compose.yaml", deployedAt: "2026-11-20T10:00:00.000Z" }));
    await deployStack(args("owned", pushed({ "compose.yaml": "services: {}\n" }, OTHER)), granted, OTHER, docker);
    expect((await readDeployRecord(dir))?.owner).toBe(OTHER);
});

test("a managed .env is written 0600 and its digest recorded and answered; one placed or edited by hand is refused and left untouched", async () => {
    const dir = join(stacksRoot(), "envs");
    const { docker } = fakeDocker();
    const env = "DATABASE_URL=postgres://app:s3cret-pass@db/app\nMODE=production\n";
    const answer = answerOf(await deployStack(args("envs", pushed(), { env }), granted, SANDBOX, docker, fakeDeploySeams().seams));
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(env);
    expect(mode(join(dir, ".env"))).toBe(0o600);
    expect(answer.envDigest).toBe(envDigestOf(env));
    expect(answer.envDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await readDeployRecord(dir))?.envDigest).toBe(envDigestOf(env));

    // The agent's own .env is replaced by the next managed deploy, and kept (with its digest) by a plain one.
    const next = "DATABASE_URL=postgres://app:rotated-pass@db/app\n";
    await deployStack(args("envs", pushed(), { env: next }), granted, SANDBOX, docker, fakeDeploySeams().seams);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(next);
    await deployStack(args("envs", pushed()), granted, SANDBOX, docker);
    expect((await readDeployRecord(dir))?.envDigest).toBe(envDigestOf(next));

    // Edited by hand since: refused, before anything is copied or compose is asked, and never overwritten.
    write(join(dir, ".env"), `${next}EXTRA=added-by-hand\n`);
    const edited = fakeDocker();
    const source = pushed({ "compose.yaml": "services: { changed: {} }\n" });
    const failure = String(await deployStack(args("envs", source, { env: "DATABASE_URL=new\n" }), granted, SANDBOX, edited.docker).catch(String));
    expect(failure).toContain(`Refused to deploy "envs": ${join(dir, ".env")} was placed or edited by hand (it changed since the last deploy wrote it)`);
    expect(failure).toContain("A person on this device must move it away");
    expect(failure).not.toContain("rotated-pass");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`${next}EXTRA=added-by-hand\n`);
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).not.toContain("changed");
    expect(composeRuns(edited.calls)).toEqual([]);

    // Placed by hand before any managed deploy: the same.
    const placed = join(stacksRoot(), "placed");
    write(join(placed, ".env"), "TOKEN=the-owners\n");
    await expect(deployStack(args("placed", pushed(), { env: "TOKEN=rendered\n" }), granted, SANDBOX, docker)).rejects.toThrow("(no deploy wrote it)");
    expect(readFileSync(join(placed, ".env"), "utf8")).toBe("TOKEN=the-owners\n");
    expect(existsSync(join(placed, "compose.yaml"))).toBe(false);
});

test("registry logins go in the stack's own docker config, handed to compose as DOCKER_CONFIG, and go when a deploy declares none", async () => {
    const dir = join(stacksRoot(), "private");
    const user = mkdtempSync(join(tmpdir(), "docker-config-"));
    mkdirSync(join(user, "cli-plugins"));
    write(join(user, "config.json"), JSON.stringify({ currentContext: "desktop-linux", credsStore: "desktop" }));
    const registries = [{ host: "ghcr.io", username: "me", password: "ghp_registrytoken123" }];
    const { docker, calls } = fakeDocker();

    const answer = answerOf(
        await deployStack(args("private", pushed(), { mode: "images", registries }), granted, SANDBOX, docker, fakeDeploySeams({ userDockerDir: user }).seams),
    );

    const config = join(dir, STACK_STATE_DIR, "docker");
    expect(JSON.parse(readFileSync(join(config, "config.json"), "utf8"))).toEqual({
        auths: { "ghcr.io": { auth: Buffer.from("me:ghp_registrytoken123").toString("base64") } },
        currentContext: "desktop-linux",
    });
    expect(mode(join(config, "config.json"))).toBe(0o600);
    expect(mode(config)).toBe(0o700);
    expect(mode(join(dir, STACK_STATE_DIR))).toBe(0o700);
    expect(readlinkSync(join(config, "cli-plugins"))).toBe(join(user, "cli-plugins"));
    expect(existsSync(join(config, "contexts"))).toBe(false);
    expect(composeRuns(calls).map((call) => call.env)).toEqual([{ DOCKER_CONFIG: config }, { DOCKER_CONFIG: config }]);
    expect(answer.output).not.toContain("ghp_registrytoken123");

    // The board's `pull` on the stack reaches the same registry.
    const listed = fakeDocker({ ps: dockerAnswered(container({ container: "private-web-1", project: "private", service: "web", workingDir: dir, configFiles: join(dir, "compose.yaml") })) });
    await stackAction("private", "pull", granted, SANDBOX, listed.docker);
    expect(composeRuns(listed.calls).map((call) => call.env)).toEqual([{ DOCKER_CONFIG: config }, { DOCKER_CONFIG: config }]);

    const later = fakeDocker();
    await deployStack(args("private", pushed(), { mode: "images" }), granted, SANDBOX, later.docker, fakeDeploySeams({ userDockerDir: user }).seams);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(user, "cli-plugins"))).toBe(true);
    expect(composeRuns(later.calls).map((call) => call.env)).toEqual([undefined, undefined]);
});

test("images mode pulls and then brings up without building; pins are laid over the compose file, and a stale pins file goes", async () => {
    const dir = join(stacksRoot(), "pinned");
    const file = join(dir, "compose.yaml");
    const pinsFile = join(dir, STACK_STATE_DIR, "pins.yaml");
    const pins = { web: `ghcr.io/me/web@sha256:${  "a".repeat(64)}` };
    const { docker, calls } = fakeDocker();

    await deployStack(args("pinned", pushed(), { mode: "images", pins }), granted, SANDBOX, docker, fakeDeploySeams().seams);

    expect(composeRuns(calls).map((call) => call.args)).toEqual([
        ["compose", "-p", "pinned", "-f", file, "-f", pinsFile, "pull"],
        ["compose", "-p", "pinned", "-f", file, "-f", pinsFile, "up", "-d", "--remove-orphans"],
    ]);
    expect(JSON.parse(readFileSync(pinsFile, "utf8"))).toEqual({ services: { web: { image: pins.web } } });

    const later = fakeDocker();
    await deployStack(args("pinned", pushed(), { mode: "build" }), granted, SANDBOX, later.docker, fakeDeploySeams().seams);
    expect(existsSync(pinsFile)).toBe(false);
    expect(composeRuns(later.calls).map((call) => call.args)).toEqual([["compose", "-p", "pinned", "-f", file, "up", "-d", "--build", "--remove-orphans"]]);
});

test("a failing preDeploy hook stops the deploy before compose, with what it printed; the hook runs in the stack's folder as the project", async () => {
    const dir = join(stacksRoot(), "hooked");
    const { docker, calls } = fakeDocker();
    const fake = fakeDeploySeams({ hook: () => ({ status: 3, stdout: "migrating\n", stderr: "relation \"users\" already exists\n" }) });

    const failure = await deployStack(args("hooked", pushed(), { hooks: { preDeploy: "./migrate.sh" } }), granted, SANDBOX, docker, fake.seams).catch(String);

    expect(failure).toContain(
        "The preDeploy hook failed (exit 3), so compose was not run: the containers that ran before still run, and the folder holds the new files.\n\nmigrating\nrelation \"users\" already exists",
    );
    expect(composeRuns(calls)).toEqual([]);
    expect(fake.hooks).toEqual([{ script: "./migrate.sh", cwd: dir, env: { COMPOSE_PROJECT_NAME: "hooked", COMPOSE_FILE: join(dir, "compose.yaml") } }]);
});

test("a postDeploy hook runs once compose is up, and its failure fails the deploy", async () => {
    const { docker, calls } = fakeDocker();
    const fake = fakeDeploySeams({ hook: (script) => (script === "notify" ? { status: 1, stdout: "", stderr: "webhook refused\n" } : undefined) });
    await expect(deployStack(args("notified", pushed(), { hooks: { postDeploy: "notify" } }), granted, SANDBOX, docker, fake.seams)).rejects.toThrow(
        "The postDeploy hook failed (exit 1), after the stack came up.\n\nwebhook refused",
    );
    expect(composeRuns(calls).map((call) => call.args.at(-1))).toEqual(["--remove-orphans"]);
});

// The project's containers as the health wait and the digest read see them.
const projectDocker = (name: string, rows: readonly string[]) =>
    fakeDocker({
        respond: (asked) => {
            if (asked[0] === "ps" && asked.includes(`label=com.docker.compose.project=${name}`)) {
                return dockerAnswered(rows.join("\n"));
            }
            if (asked[0] === "inspect") {
                expect(asked.slice(0, 3)).toEqual(["inspect", "--format", CONTAINER_IMAGE_FORMAT]);
                return dockerAnswered(
                    [
                        JSON.stringify({ service: "web", ref: "ghcr.io/me/web:main", image: "sha256:web" }),
                        JSON.stringify({ service: "worker", ref: "healthy-worker", image: "sha256:worker" }),
                    ].join("\n"),
                );
            }
            if (asked[0] === "image") {
                expect(asked.slice(0, 4)).toEqual(["image", "inspect", "--format", IMAGE_DIGESTS_FORMAT]);
                return dockerAnswered(
                    [
                        JSON.stringify({ id: "sha256:web", repoDigests: [`ghcr.io/me/web@sha256:${"b".repeat(64)}`] }),
                        JSON.stringify({ id: "sha256:worker", repoDigests: [] }),
                    ].join("\n"),
                );
            }
            return undefined;
        },
    });

test("a stack that comes up answers how long it took and the images it runs, pinned; one that does not fails at its timeout saying what was not ready", async () => {
    const up = projectDocker("healthy", [
        container({ container: "healthy-web-1", project: "healthy", service: "web", status: "Up 6 seconds (healthy)" }),
        container({ container: "healthy-worker-1", project: "healthy", service: "worker" }),
    ]);
    const fine = fakeDeploySeams();
    const health = StackHealthSchema.parse({ http: ["http://127.0.0.1:8080/health"] });

    const answer = answerOf(await deployStack(args("healthy", pushed(), { mode: "images", health }), granted, SANDBOX, up.docker, fine.seams));

    expect(answer.healthySeconds).toBe(5);
    expect(fine.slept).toEqual([5_000]);
    expect(fine.probed).toEqual(["http://127.0.0.1:8080/health"]);
    expect(answer.digests).toEqual({ web: `ghcr.io/me/web@sha256:${"b".repeat(64)}`, worker: "sha256:worker" });

    const down = projectDocker("sick", [container({ container: "sick-web-1", project: "sick", service: "web", state: "restarting", status: "Restarting (1) 2 seconds ago" })]);
    const sick = fakeDeploySeams({ probe: (url) => `${url} answered 502` });
    const failure = await deployStack(args("sick", pushed(), { health: { timeoutSeconds: 10, http: ["http://127.0.0.1:8081/"] } }), granted, SANDBOX, down.docker, sick.seams).catch(
        String,
    );
    expect(failure).toContain('"sick" did not come up healthy within 10 s: web is restarting (Restarting (1) 2 seconds ago); http://127.0.0.1:8081/ answered 502.');
    // Looks at 5, 8 and 10 seconds: the last at the timeout itself.
    expect(sick.slept).toEqual([5_000, 3_000, 2_000]);
    expect(sick.probed).toHaveLength(3);
});

test("adopt takes over a project no deploy put here once none of its containers runs; a running one stays refused", async () => {
    const komodo = (state: string) =>
        fakeDocker({
            ls: dockerAnswered(JSON.stringify([{ Name: "legacy", Status: `${state}(1)`, ConfigFiles: "/etc/komodo/stacks/legacy/compose.yaml" }])),
            ps: dockerAnswered(container({ container: "legacy-db-1", project: "legacy", service: "db", state, status: state === "running" ? "Up 3 days" : "Exited (0) 1 hour ago", workingDir: "/etc/komodo/stacks/legacy" })),
        });

    const running = komodo("running");
    await expect(deployStack(args("legacy", pushed(), { adopt: true }), granted, SANDBOX, running.docker, fakeDeploySeams().seams)).rejects.toThrow(
        'A compose project called "legacy" already runs on this device from /etc/komodo/stacks/legacy, which no deploy put there: deploying under its name would replace its containers. It is adopted only once none of its containers is running, and legacy-db-1 is running: stop it on this device, then deploy again.',
    );
    expect(existsSync(join(stacksRoot(), "legacy"))).toBe(false);
    const unasked = komodo("exited");
    await expect(deployStack(args("legacy", pushed()), granted, SANDBOX, unasked.docker)).rejects.toThrow("A project whose containers are all stopped can be taken over with adopt.");

    const stopped = komodo("exited");
    await deployStack(args("legacy", pushed(), { adopt: true }), granted, SANDBOX, stopped.docker, fakeDeploySeams().seams);
    expect(composeRuns(stopped.calls).map((call) => call.args.slice(0, 3))).toEqual([["compose", "-p", "legacy"]]);
    expect((await readDeployRecord(join(stacksRoot(), "legacy")))?.owner).toBe(SANDBOX);

    // Never a sandbox's own project, stopped or not.
    const sandbox = fakeDocker({ ps: dockerAnswered(container({ container: "intentic-x-1", project: "intentic-x", state: "exited", workingDir: "/srv/x", kind: "sandbox" })) });
    await expect(deployStack(args("intentic-x", pushed(), { adopt: true }), granted, SANDBOX, sandbox.docker, fakeDeploySeams().seams)).rejects.toThrow(
        "is an Intentic sandbox's own compose project on this device",
    );
});

test("no secret the deploy carried comes back, in its answer or in its failure", async () => {
    const env = "API_KEY=sk-live-0123456789abcdef\nSHORT=on\n";
    const registries = [{ host: "registry.example.com:5000", username: "deployer", password: "registry-password-1" }];
    const echoing = fakeDocker({ compose: { status: 1, stdout: "", stderr: "invalid interpolation: sk-live-0123456789abcdef and registry-password-1\n" } });
    const failure = await deployStack(args("leaky", pushed(), { env, registries }), granted, SANDBOX, echoing.docker, fakeDeploySeams().seams).catch(String);
    expect(failure).toContain("invalid interpolation: [hidden] and [hidden]");
    expect(failure).not.toContain("sk-live");
    expect(failure).not.toContain("registry-password-1");

    const printing = fakeDocker({ compose: dockerAnswered("", " using sk-live-0123456789abcdef\n") });
    const answer = await deployStack(args("leaky", pushed(), { env, registries }), granted, SANDBOX, printing.docker, fakeDeploySeams().seams);
    expect(answer).not.toContain("sk-live");
    expect(answerOf(answer).output).toBe(" using [hidden]");
});
