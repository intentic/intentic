import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARTIFACT_CHUNK_BYTES, ArtifactNameSchema, type StageArtifact } from "@intentic/sandbox-contract/schemas/device-artifacts";
import { ORPCError } from "@orpc/server";
import { extract } from "tar-stream";
import { gitOut } from "../../harness/route-fakes.testing.js";
import { COMPOSE_FILE_DEFAULTS, committedStack, repoFolder } from "./device-stack-bundle.js";
import { deployDeviceStack } from "./device-stacks.js";
import { STACK_DEVICE, stackDevice, type StackDeviceOptions } from "./device-stacks.testing.js";

// A deploy against real git: which repository and which compose file it resolves, that only the last commit is packed
// and carried, and what the machine's `deploy_stack` is then asked. The computer is the fake in device-stacks.testing.ts.

let root: string;
let outside: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-stacks-work-"));
    outside = await mkdtemp(join(tmpdir(), "intentic-stacks-outside-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

const writeFiles = async (dir: string, files: Readonly<Record<string, string | Buffer>>): Promise<void> => {
    for (const [path, body] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), body);
    }
};

const commit = async (dir: string): Promise<string> => {
    await gitOut(dir, "add", "-A");
    await gitOut(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
    return await gitOut(dir, "rev-parse", "HEAD");
};

// A repository at `<parent>/<name>` holding `files` in one commit; its HEAD.
const repoAt = async (parent: string, name: string, files: Readonly<Record<string, string | Buffer>>): Promise<string> => {
    const dir = join(parent, name);
    await mkdir(dir, { recursive: true });
    await gitOut(dir, "init", "-q", "-b", "main");
    await writeFiles(dir, files);
    return await commit(dir);
};

const composeOf = async (repo: string, composeFile?: string): Promise<string> =>
    (await committedStack(await repoFolder(root, repo), repo, composeFile)).composeFile;

// Each file in a tar the machine received, by path, as text.
const filesIn = async (tar: Buffer): Promise<Map<string, string>> => {
    const files = new Map<string, string>();
    const reader = extract();
    reader.end(tar);
    for await (const entry of reader) {
        const pieces: Uint8Array[] = [];
        for await (const piece of entry) {
            if (piece instanceof Uint8Array) {
                pieces.push(piece);
            }
        }
        if (entry.header.type === "file") {
            files.set(entry.header.name, Buffer.concat(pieces).toString("latin1"));
        }
    }
    return files;
};

const deployed = { path: "/home/me/.intentic/stacks/shop", output: " Container shop-web-1  Started\n" };
const deployingDevice = (over: StackDeviceOptions = {}) =>
    stackDevice({ root, tool: async (call) => ({ text: call.tool === "deploy_stack" ? JSON.stringify(deployed) : "" }), ...over });

test("with no compose file named, the first of compose's own names at the commit's root is run", async () => {
    await repoAt(root, "all", { "docker-compose.yml": "a", "compose.yml": "b", "docker-compose.yaml": "c", "deploy/compose.yaml": "d" });
    await repoAt(root, "legacy", { "docker-compose.yml": "a", "docker-compose.yaml": "c" });
    await repoAt(root, "nested", { "deploy/compose.yaml": "d", "README.md": "e" });
    expect(await composeOf("all")).toBe("compose.yml");
    expect(await composeOf("legacy")).toBe("docker-compose.yaml");
    await expect(composeOf("nested")).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `"nested"'s last commit (${(await gitOut(join(root, "nested"), "rev-parse", "HEAD")).slice(0, 12)}) has none of ${COMPOSE_FILE_DEFAULTS.join(", ")} at its root: commit one, or name the compose file to run`,
    });
});

test("a compose file that is named must be a file in the last commit", async () => {
    const head = await repoAt(root, "shop", { "deploy/compose.yaml": "services: {}\n", "compose.yaml": "services: {}\n" });
    await writeFiles(join(root, "shop"), { "later.yaml": "services: {}\n" });
    expect(await composeOf("shop", "deploy/compose.yaml")).toBe("deploy/compose.yaml");
    for (const named of ["missing.yaml", "deploy", "later.yaml"]) {
        await expect(composeOf("shop", named)).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: `"${named}" is not a file in "shop"'s last commit (${head.slice(0, 12)}): commit it, or name another compose file`,
        });
    }
});

test("a repository with no commits is refused, saying to commit first", async () => {
    await mkdir(join(root, "fresh"));
    await gitOut(join(root, "fresh"), "init", "-q", "-b", "main");
    await expect(composeOf("fresh")).rejects.toMatchObject({ code: "BAD_REQUEST", message: `"fresh" has no commits yet: commit what should run, then deploy` });
});

test("a repository is named by its folder in the workspace, and nothing outside the workspace is reached", async () => {
    await repoAt(outside, "elsewhere", { "compose.yaml": "services: {}\n" });
    await repoAt(root, "shop", { "compose.yaml": "services: {}\n", "web/index.html": "hi" });
    await symlink(join(outside, "elsewhere"), join(root, "link"));
    await mkdir(join(root, "plain"));
    const refusals: readonly (readonly [string, string])[] = [
        ["../elsewhere", `"../elsewhere" is not a repository in this workspace: name it by its folder under the workspace, like my-app or apps/web`],
        [join(outside, "elsewhere"), `"${join(outside, "elsewhere")}" is not a repository in this workspace: name it by its folder under the workspace, like my-app or apps/web`],
        ["shop/../../elsewhere", `"shop/../../elsewhere" is not a repository in this workspace: name it by its folder under the workspace, like my-app or apps/web`],
        ["link", `"link" leads outside this workspace`],
        ["gone", `there is no folder "gone" in this workspace`],
        ["plain", `"plain" is not a git repository: a deploy carries a commit, so the folder must be a repository's own top`],
        ["shop/web", `"shop/web" is not a git repository: a deploy carries a commit, so the folder must be a repository's own top`],
    ];
    for (const [repo, message] of refusals) {
        await expect(repoFolder(root, repo)).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    }
    // Refused before anything is carried: the computer is never asked.
    const { services, staging, tools } = deployingDevice();
    await expect(deployDeviceStack(services, { id: STACK_DEVICE, name: "shop", repo: "link" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(staging).toEqual([]);
    expect(tools).toEqual([]);
});

test("a deploy carries the last commit's tree, never the edits around it, and asks the computer to run it from where it landed", async () => {
    // Past one chunk, so the pieces must arrive in order and add up to what was packed.
    const blob = randomBytes(3 * 1024 * 1024);
    const head = await repoAt(root, "shop", { "compose.yaml": "services:\n  web:\n    build: .\n", "Dockerfile": "FROM scratch\n", "assets/blob.bin": blob });
    await writeFiles(join(root, "shop"), { "compose.yaml": "uncommitted edit\n", "notes.txt": "never committed\n" });
    const { services, staging, tools } = deployingDevice();

    const answer = await deployDeviceStack(services, { id: STACK_DEVICE, name: "shop", repo: "shop" });

    expect(staging.map((op) => op.op)).toEqual(["have", "chunk", "chunk", "commit"]);
    const chunks = staging.filter((op): op is Extract<StageArtifact, { op: "chunk" }> => op.op === "chunk");
    const tar = Buffer.concat(chunks.map((op) => Buffer.from(op.data, "base64")));
    expect(chunks.map((op) => op.offset)).toEqual([0, ARTIFACT_CHUNK_BYTES]);
    const sha256 = createHash("sha256").update(tar).digest("hex");
    expect(staging[0]).toEqual({ op: "have", name: "stack-shop", sha256, kind: "tar", fileName: "shop.tar" });
    const committed = staging.at(-1);
    const upload = committed?.op === "commit" ? committed.upload : "";
    expect(committed).toEqual({ op: "commit", upload, name: "stack-shop", kind: "tar", fileName: "shop.tar", size: tar.byteLength, sha256 });
    expect(chunks.map((op) => op.upload)).toEqual([upload, upload]);
    const files = await filesIn(tar);
    expect([...files.keys()].toSorted()).toEqual(["Dockerfile", "assets/blob.bin", "compose.yaml"]);
    expect(files.get("compose.yaml")).toBe("services:\n  web:\n    build: .\n");
    expect(files.get("assets/blob.bin")).toBe(blob.toString("latin1"));

    const source = `/home/me/.intentic/runs/stack-shop/${sha256.slice(0, 12)}`;
    // Over the connection that staged it, the only agent whose runs folder holds `source`.
    expect(tools.map(({ device, tool, args }) => ({ device, tool, args }))).toEqual([
        { device: STACK_DEVICE, tool: "deploy_stack", args: { source, name: "shop", composeFile: "compose.yaml", commit: head } },
    ]);
    expect(answer).toEqual({ stack: "shop", path: deployed.path, commit: head, output: deployed.output });
});

test("a tree the computer already holds is not carried again, and a long stack name still makes a staging name it accepts", async () => {
    const head = await repoAt(root, "shop", { "deploy/compose.yaml": "services: {}\n" });
    const name = `s${"x".repeat(62)}`;
    const { services, staging, tools } = deployingDevice({ stage: async () => ({ path: "/home/me/.intentic/runs/held" }) });

    await deployDeviceStack(services, { id: STACK_DEVICE, name, repo: "shop", composeFile: "deploy/compose.yaml" });

    expect(staging.map((op) => op.op)).toEqual(["have"]);
    const asked = staging[0]?.op === "have" ? staging[0].name : "";
    expect(asked).toBe(`stack-${name}`.slice(0, 64));
    expect(ArtifactNameSchema.safeParse(asked).success).toBe(true);
    expect(tools.map(({ args }) => args)).toEqual([{ source: "/home/me/.intentic/runs/held", name, composeFile: "deploy/compose.yaml", commit: head }]);
});

test("the computer refusing what this sandbox sends is FORBIDDEN in its words, the upload is thrown away, and nothing is deployed", async () => {
    await repoAt(root, "shop", { "compose.yaml": "services: {}\n" });
    const said = 'Receiving programs needs "Run programs this sandbox sends" switched on for this sandbox on rog.';
    const onChunk = deployingDevice({
        stage: async (op) => {
            if (op.op === "chunk") {
                throw new ORPCError("FORBIDDEN", { message: said });
            }
            return {};
        },
    });
    await expect(deployDeviceStack(onChunk.services, { id: STACK_DEVICE, name: "shop", repo: "shop" })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    expect(onChunk.staging.map((op) => op.op)).toEqual(["have", "chunk", "abort"]);
    expect(onChunk.tools).toEqual([]);

    const onAsking = deployingDevice({
        stage: async () => {
            throw new ORPCError("FORBIDDEN", { message: said });
        },
    });
    await expect(deployDeviceStack(onAsking.services, { id: STACK_DEVICE, name: "shop", repo: "shop" })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    expect(onAsking.staging.map((op) => op.op)).toEqual(["have"]);
});

test("a deploy the computer answers with something else is a bad gateway naming it", async () => {
    await repoAt(root, "shop", { "compose.yaml": "services: {}\n" });
    const { services } = stackDevice({ root, tool: async () => ({ text: "compose up finished" }) });
    await expect(deployDeviceStack(services, { id: STACK_DEVICE, name: "shop", repo: "shop" })).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${STACK_DEVICE}" answered deploy_stack with something other than what it promises: "compose up finished"`,
    });
});
