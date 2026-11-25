import { type DeviceStack, type StackContainerState, StackHealthSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import { dockerAnswered, fakeDeploySeams, fakeDocker } from "../../device-testing.js";
import { HEALTH_POLL_MS, HEALTH_SETTLE_MS, notReadyBecause, pinnedImage, projectContainersArgs, repoOf, waitHealthy } from "./deploy-health.js";
import { DEPLOY_DEADLINE_MS, refuseTakeover } from "./deploy.js";
import { hideSecrets, pinsOverride, secretsOf } from "./stack-state.js";
import { type ContainerRow, CONTAINERS_FORMAT, parseContainers } from "./stacks.js";

/* The parts of a managed deploy that read no disk: when a container counts as up, which digest pins an image, what is
   hidden from an answer, and when a project may be adopted. Docker and the clock are fakes (device-testing.ts). */

// One container as `docker ps` prints it through CONTAINERS_FORMAT, read back.
const row = (fields: Readonly<Record<string, string>>): ContainerRow => {
    const line = JSON.stringify({ container: "a-web-1", image: "", state: "running", status: "Up 1 minute", project: "a", service: "web", workingDir: "", configFiles: "", kind: "", ...fields });
    const [read] = parseContainers(line);
    if (read === undefined) {
        throw new Error(`no container in ${line}`);
    }
    return read;
};

test("a container is ready running, healthy where it declares a healthcheck, or exited 0 as a finished one-shot", () => {
    expect(notReadyBecause(row({}))).toBeUndefined();
    expect(notReadyBecause(row({ status: "Up 2 minutes (healthy)" }))).toBeUndefined();
    expect(notReadyBecause(row({ status: "Up 4 seconds (health: starting)" }))).toBe("web is still starting (its healthcheck has not passed yet)");
    expect(notReadyBecause(row({ status: "Up 2 minutes (unhealthy)" }))).toBe("web is unhealthy");
    expect(notReadyBecause(row({ state: "restarting", status: "Restarting (1) 3 seconds ago" }))).toBe("web is restarting (Restarting (1) 3 seconds ago)");
    expect(notReadyBecause(row({ service: "migrate", state: "exited", status: "Exited (0) 10 seconds ago" }))).toBeUndefined();
    expect(notReadyBecause(row({ state: "exited", status: "Exited (137) 10 seconds ago" }))).toBe("web is exited (Exited (137) 10 seconds ago)");
    expect(notReadyBecause(row({ state: "created", status: "Created" }))).toBe("web is created (Created)");
});

test("the health wait reads only the project's own containers, never `compose run`'s one-offs", () => {
    expect(projectContainersArgs("shop")).toEqual([
        "ps",
        "-a",
        "--filter",
        "label=com.docker.compose.project=shop",
        "--filter",
        "label=com.docker.compose.oneoff=False",
        "--format",
        CONTAINERS_FORMAT,
    ]);
});

test("the health wait trusts nothing in its first seconds, and stops at the deploy's deadline when that comes first", async () => {
    const starting = JSON.stringify({ container: "a-web-1", image: "", state: "running", status: "Up 1 second (health: starting)", project: "a", service: "web", workingDir: "", configFiles: "", kind: "" });
    const { docker } = fakeDocker({ ps: dockerAnswered(starting) });
    const fake = fakeDeploySeams();
    const health = StackHealthSchema.parse({ timeoutSeconds: 600 });
    const deadline = fake.seams.now() + 20_000;

    await expect(waitHealthy("a", health, docker, fake.seams, deadline)).rejects.toThrow('"a" did not come up healthy within 20 s: web is still starting');
    expect(fake.slept[0]).toBe(HEALTH_SETTLE_MS);
    expect(fake.slept.slice(1, -1).every((ms) => ms === HEALTH_POLL_MS)).toBe(true);
    expect(fake.slept.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
    expect(DEPLOY_DEADLINE_MS).toBe(14 * 60_000);
});

test("a service's image is pinned by the registry digest of the repository it names, else by its image id", () => {
    expect(repoOf("ghcr.io/me/api:main")).toBe("ghcr.io/me/api");
    expect(repoOf("localhost:5000/app:1")).toBe("localhost:5000/app");
    expect(repoOf("localhost:5000/app")).toBe("localhost:5000/app");
    expect(repoOf(`ghcr.io/me/api@sha256:${"c".repeat(64)}`)).toBe("ghcr.io/me/api");
    expect(repoOf("docker.io/library/postgres:18")).toBe("postgres");
    expect(repoOf("postgres")).toBe("postgres");
    const pg = `postgres@sha256:${"d".repeat(64)}`;
    expect(pinnedImage("postgres:18", "sha256:pg", [`mirror.example.com/postgres@sha256:${"e".repeat(64)}`, pg])).toBe(pg);
    expect(pinnedImage("docker.io/library/postgres:18", "sha256:pg", [pg])).toBe(pg);
    // Built here, or pulled under another name: the image id.
    expect(pinnedImage("shop-web", "sha256:built", [])).toBe("sha256:built");
    expect(pinnedImage("ghcr.io/me/api:main", "sha256:api", [`ghcr.io/me/other@sha256:${"f".repeat(64)}`])).toBe("sha256:api");
});

test("pins are a compose override naming each service's image", () => {
    expect(JSON.parse(pinsOverride({ "web-1": "ghcr.io/me/web@sha256:aa", "a\"b": "x" }))).toEqual({ services: { "web-1": { image: "ghcr.io/me/web@sha256:aa" }, 'a"b': { image: "x" } } });
});

test("every env value and registry login long enough to be a secret is hidden from what a deploy says, quoted or not, and on every line it spans", () => {
    const env = ['DATABASE_URL="postgres://app:pw-0123456789@db/app"', "PORT=8080", "export TOKEN='tok-abcdefghij'", 'CERT="-----BEGIN CERT-----', "MIIBszCCAVmgAwIBAgIU", '-----END CERT-----"'].join("\n");
    const secrets = secretsOf({ env, registries: [{ host: "ghcr.io", username: "me", password: "ghp_0123456789" }] });
    const said = hideSecrets(
        `url postgres://app:pw-0123456789@db/app port 8080 token tok-abcdefghij cert MIIBszCCAVmgAwIBAgIU login ghp_0123456789 auth ${Buffer.from("me:ghp_0123456789").toString("base64")}`,
        secrets,
    );
    expect(said).toBe("url [hidden] port 8080 token [hidden] cert [hidden] login [hidden] auth [hidden]");
    expect(secretsOf({})).toEqual([]);
});

// A project another tool started from /srv/legacy, one `db` container per state given.
const legacy = (states: readonly StackContainerState[], kind: Pick<DeviceStack, "managed" | "sandbox"> = { managed: false, sandbox: false }): DeviceStack => ({
    name: "legacy",
    status: "",
    configFiles: [],
    workingDir: "/srv/legacy",
    ...kind,
    services: states.map((state) => ({ service: "db", container: `legacy-db-${state}`, image: "postgres:18", state, status: "" })),
});

test("adopt takes a project no deploy put here only once none of its containers runs", () => {
    expect(() => refuseTakeover(legacy(["exited", "created", "dead"]), true)).not.toThrow();
    for (const state of ["running", "restarting", "paused"] as const) {
        expect(() => refuseTakeover(legacy(["exited", state]), true)).toThrow(`legacy-db-${state} is ${state}: stop it on this device`);
    }
    expect(() => refuseTakeover(legacy(["exited"]), false)).toThrow("Deploy under another name.");
    expect(() => refuseTakeover(legacy(["exited"], { managed: false, sandbox: true }), true)).toThrow("an Intentic sandbox's own compose project");
    expect(() => refuseTakeover(legacy(["running"], { managed: true, sandbox: false }), false)).not.toThrow();
    expect(() => refuseTakeover(undefined, false)).not.toThrow();
});
