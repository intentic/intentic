import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveDesiredStateSecrets } from "./desired-state-secrets.js";
import { fileSandboxSecrets } from "./sandbox-secrets.js";

// The one-time copy of the retired desired-state repo's secrets into the sandbox's own store, over real files.

const roots = async (): Promise<{ workspace: string; history: string; repo: string; store: ReturnType<typeof fileSandboxSecrets> }> => {
    const base = await mkdtemp(join(tmpdir(), "desired-state-secrets-"));
    const workspace = join(base, "work");
    const history = join(base, "history");
    const repo = join(workspace, "desired-state");
    await mkdir(repo, { recursive: true });
    await mkdir(history, { recursive: true });
    return { workspace, history, repo, store: fileSandboxSecrets(join(base, "auth", "sandbox-secrets.json")) };
};

test("the .env and the generated values are copied in, a name the store holds keeps its value, and the repo is not touched", async () => {
    const { workspace, history, repo, store } = await roots();
    const env = 'HOST_SSH_KEY="pem-body"\nSHARED="from-the-env"\nEMPTY=\n';
    const generated = JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "pw1", SHARED: "from-generated", ODD: 42, "not a name": "x" });
    await writeFile(join(repo, ".env"), env);
    await writeFile(join(repo, ".secrets.json"), generated);
    await store.set("HOST_SSH_KEY", "already-here");
    const before = await stat(join(repo, ".env"));

    const outcome = await moveDesiredStateSecrets(workspace, history, store);

    expect(outcome).toEqual({ moved: ["SHARED", "FORGEJO_ADMIN_PASSWORD"], kept: ["HOST_SSH_KEY"] });
    expect(await store.all()).toEqual({ HOST_SSH_KEY: "already-here", SHARED: "from-the-env", FORGEJO_ADMIN_PASSWORD: "pw1" });
    expect(await readFile(join(repo, ".env"), "utf8")).toBe(env);
    expect(await readFile(join(repo, ".secrets.json"), "utf8")).toBe(generated);
    expect((await stat(join(repo, ".env"))).mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(repo)).toSorted()).toEqual([".env", ".secrets.json"]);
    // The marker names what moved, never a value.
    const marker = await readFile(join(history, "desired-state-secrets.moved"), "utf8");
    expect(marker).toContain("FORGEJO_ADMIN_PASSWORD");
    expect(marker).not.toContain("pw1");
});

test("it runs once: a secret the owner deleted afterwards is not brought back", async () => {
    const { workspace, history, repo, store } = await roots();
    await writeFile(join(repo, ".env"), "API_TOKEN=abc123\n");
    expect(await moveDesiredStateSecrets(workspace, history, store)).toEqual({ moved: ["API_TOKEN"], kept: [] });
    await store.remove("API_TOKEN");

    expect(await moveDesiredStateSecrets(workspace, history, store)).toBeUndefined();
    expect(await store.all()).toEqual({});
});

test("a workspace without the repo's secret files has nothing to copy and leaves no marker", async () => {
    const { workspace, history, store } = await roots();
    expect(await moveDesiredStateSecrets(workspace, history, store)).toBeUndefined();
    expect(await readdir(history)).toEqual([]);
});

test("an unreadable generated file stops the copy without quoting it, and leaves no marker so the next boot tries again", async () => {
    const { workspace, history, repo, store } = await roots();
    await writeFile(join(repo, ".env"), "API_TOKEN=abc123\n");
    await writeFile(join(repo, ".secrets.json"), '{"LEAKY": "secret-value-7');
    const failure = await moveDesiredStateSecrets(workspace, history, store).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("secret-value-7");
    expect(await store.all()).toEqual({});
    expect(await readdir(history)).toEqual([]);
});
