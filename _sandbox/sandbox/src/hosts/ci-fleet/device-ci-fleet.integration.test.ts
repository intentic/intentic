import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOut } from "../../harness/route-fakes.testing.js";
import { registerDeviceCiRunner } from "../../ci/fleet/runner-registration.js";
import { FLEET_DEVICE, fleetDevice, type FleetDeviceOptions, MINTED } from "./device-ci-fleet.testing.js";

// A registration against real git: which GitHub repository a workspace repository's remotes resolve to, the
// registration token minted for it, and what the machine's `ci_runner_register` is then asked. The computer and GitHub
// are the fakes in device-ci-fleet.testing.ts.

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-ci-fleet-work-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

// A repository at `<root>/<name>` with these remotes, `origin` first.
const repoWith = async (name: string, remotes: Readonly<Record<string, string>>): Promise<void> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await gitOut(dir, "init", "-q", "-b", "main");
    for (const [remote, url] of Object.entries(remotes)) {
        await gitOut(dir, "remote", "add", remote, url);
    }
};

const device = (over: FleetDeviceOptions = {}) => fleetDevice({ root, tool: async () => ({ text: "radarsu-worker-4 registered to acme/web and started." }), ...over });
const registering = { id: FLEET_DEVICE, repo: "web", name: "radarsu-worker-4", labels: ["self-hosted", "linux"] };

test("a registration mints a token for the repository origin names, and hands the machine its url, token, name and labels", async () => {
    await repoWith("web", { origin: "git@github.com:acme/web.git", upstream: "https://github.com/upstream/web.git" });
    const { services, tools, mints, fetchFn } = device();
    expect(await registerDeviceCiRunner(services, registering, fetchFn)).toEqual({ said: "radarsu-worker-4 registered to acme/web and started." });
    expect(mints).toEqual([
        { url: "https://api.github.com/repos/acme/web/actions/runners/registration-token", method: "POST", authorization: "Bearer ghp_connection" },
    ]);
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([
        {
            tool: "ci_runner_register",
            args: { url: "https://github.com/acme/web", token: MINTED, name: "radarsu-worker-4", labels: ["self-hosted", "linux"] },
        },
    ]);
});

test("a repository with no github.com remote is refused by name, and nothing is minted", async () => {
    await repoWith("web", { origin: "https://gitlab.com/acme/web.git" });
    const { services, tools, mints, fetchFn } = device();
    await expect(registerDeviceCiRunner(services, registering, fetchFn)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `"web" has no remote on github.com, so there is no GitHub repository to register a runner for.`,
    });
    await expect(registerDeviceCiRunner(services, { ...registering, repo: "missing" }, fetchFn)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mints).toEqual([]);
    expect(tools).toEqual([]);
});

test("with no GitHub connection a registration is refused naming what to connect", async () => {
    await repoWith("web", { origin: "https://github.com/acme/web.git" });
    const { services, tools, mints, fetchFn } = device({ github: false });
    await expect(registerDeviceCiRunner(services, registering, fetchFn)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message:
            "Registering a runner takes a token GitHub mints for the repository, through this sandbox's GitHub connection, and none is connected: connect GitHub under Capabilities, with an account that has admin on the repository, then try again.",
    });
    expect(mints).toEqual([]);
    expect(tools).toEqual([]);
});

test("a token GitHub refuses is FORBIDDEN naming the admin the connection lacks, and the machine is never asked", async () => {
    await repoWith("web", { origin: "https://github.com/acme/web.git" });
    // A token that may not see the repository's runners is answered 404, as GitHub hides what a token may not read.
    const { services, tools, fetchFn } = device({ mint: async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) });
    await expect(registerDeviceCiRunner(services, registering, fetchFn)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: `GitHub refused to mint a runner registration token for https://github.com/acme/web (404): the connected GitHub account needs admin on acme/web (a fine-grained token's "Administration: read and write"). Grant it, or connect an account that has it, then try again.`,
    });
    expect(tools).toEqual([]);
});

test("the machine's refusal of a registration reaches the view in its own words", async () => {
    await repoWith("web", { origin: "https://github.com/acme/web.git" });
    const said = "Registering a runner needs the CI fleet service on omen: install it with `intentic-machine ci-fleet install`.";
    const { services, fetchFn } = device({ tool: async () => ({ text: said, refused: true }) });
    await expect(registerDeviceCiRunner(services, registering, fetchFn)).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
});
