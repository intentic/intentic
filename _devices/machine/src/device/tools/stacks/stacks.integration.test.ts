import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { dockerAnswered, fakeDocker } from "../../device-testing.js";
import { ScopeError } from "../../policy.js";
import { sandboxRunsDir } from "../programs/artifacts.js";
import { COMPLETE } from "../programs/builds.js";
import { copyIntoStack, DEPLOY_RECORD, planCopy } from "./stack-folder.js";
import { deployStack, stackAction, stacksRoot } from "./stacks.js";

// deploy_stack's copy, on real folders: `suites` gives this run a throwaway HOME, so the runs folder a push files into
// and the stacks root are temp ones. Docker is a fake (device-testing.ts); nothing here needs an engine. POSIX paths and
// file modes: the copy's Windows behaviour is the same code with Node's own path rules.

const SANDBOX = "https://sandbox-0a1b2c3d4e5f.example.dev";
const COMMIT = "3f2a9c1e".repeat(5);
const off: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" };
const granted: DeviceScopes = { ...off, shell: "on", programs: "on" };

const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
};

// A repository as a push files it: `<runs>/<sandbox>/<name>/<12 hex>/`, its marker written last (programs/artifacts.ts).
let pushes = 0;
const pushed = (files: Readonly<Record<string, string>>, sandboxUrl = SANDBOX): string => {
    pushes += 1;
    const dir = join(sandboxRunsDir(sandboxUrl), "stack-web", pushes.toString(16).padStart(12, "0"));
    for (const [path, text] of Object.entries(files)) {
        write(join(dir, path), text);
    }
    writeFileSync(join(dir, COMPLETE), "sha256\n");
    return dir;
};

const deploy = (source: string, name: string) => ({ source, name, composeFile: "compose.yaml", commit: COMMIT });

test("only a folder this sandbox pushed here and that was filed whole can be deployed; any other folder is refused", async () => {
    const { docker, calls } = fakeDocker();
    const elsewhere = mkdtempSync(join(tmpdir(), "stack-elsewhere-"));
    write(join(elsewhere, "compose.yaml"), "services: {}\n");
    // A refusal's own sentence, or what happened instead.
    const answer = async (source: string): Promise<string> =>
        await deployStack(deploy(source, "web"), granted, SANDBOX, docker).then(
            (deployed) => `deployed: ${deployed}`,
            (error: unknown) => (error instanceof ScopeError ? error.message : `not a refusal: ${String(error)}`),
        );
    const refusedFrom = (source: string): string =>
        `Refused to deploy from "${source}": a stack is deployed only from a folder this sandbox pushed to this device (inside ${sandboxRunsDir(SANDBOX)}), and deploy_stack copies no other folder.`;

    expect(await answer(elsewhere)).toBe(refusedFrom(elsewhere));
    // Another sandbox's push, a push still being unpacked (no marker), the runs folder itself, and a link out of it.
    const theirs = pushed({ "compose.yaml": "services: {}\n" }, "https://sandbox-ffffffffffff.example.dev");
    expect(await answer(theirs)).toBe(refusedFrom(theirs));
    const unfinished = join(sandboxRunsDir(SANDBOX), "stack-web", "00000000beef");
    write(join(unfinished, "compose.yaml"), "services: {}\n");
    expect(await answer(unfinished)).toBe(refusedFrom(unfinished));
    expect(await answer(sandboxRunsDir(SANDBOX))).toBe(refusedFrom(sandboxRunsDir(SANDBOX)));
    const leading = pushed({ "compose.yaml": "services: {}\n" });
    symlinkSync(elsewhere, join(leading, "out"));
    expect(await answer(join(leading, "out"))).toBe(refusedFrom(join(leading, "out")));
    // A path that climbs out of this sandbox's push into another sandbox's is judged where it lands.
    const climbing = `${leading}/../../../sandbox-ffffffffffff/stack-web/${basename(theirs)}`;
    expect(await answer(climbing)).toBe(refusedFrom(climbing));

    // Both switches, checked before anything is read.
    await expect(deployStack(deploy(leading, "web"), { ...granted, programs: "off" }, SANDBOX, docker)).rejects.toThrow(/Run programs this sandbox sends.*switched off/);
    await expect(deployStack(deploy(leading, "web"), { ...granted, shell: "off" }, SANDBOX, docker)).rejects.toThrow(/Run commands.*switched off/);
    expect(calls).toEqual([]);
    expect(existsSync(join(stacksRoot(), "web"))).toBe(false);
});

test("a deploy adds and overwrites, deletes nothing, never touches a .env, records the commit and brings the stack up", async () => {
    const dir = join(stacksRoot(), "shop");
    write(join(dir, ".env"), "DATABASE_PASSWORD=the-owners\n");
    write(join(dir, "data", "db.sqlite"), "rows the service wrote");
    write(join(dir, "compose.yaml"), "services: { old: {} }\n");
    const source = pushed({
        "compose.yaml": "services: { web: { build: . } }\n",
        ".env": "DATABASE_PASSWORD=committed-by-mistake\n",
        "config/.env": "TOKEN=nested\n",
        "config/app.toml": "port = 8080\n",
        [DEPLOY_RECORD]: '{"commit":"planted"}',
        "bin/entrypoint.sh": "#!/bin/sh\nexec web\n",
    });
    chmodSync(join(source, "bin", "entrypoint.sh"), 0o755);
    const { docker, calls } = fakeDocker({ compose: dockerAnswered("", " Image shop-web  Built\n Container shop-web-1  Started\n") });

    const answer: unknown = JSON.parse(await deployStack(deploy(source, "shop"), granted, SANDBOX, docker));

    expect(answer).toEqual({ path: dir, output: " Image shop-web  Built\n Container shop-web-1  Started" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("DATABASE_PASSWORD=the-owners\n");
    expect(existsSync(join(dir, "config", ".env"))).toBe(false);
    expect(readFileSync(join(dir, "data", "db.sqlite"), "utf8")).toBe("rows the service wrote");
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toBe("services: { web: { build: . } }\n");
    expect(readFileSync(join(dir, "config", "app.toml"), "utf8")).toBe("port = 8080\n");
    expect(statSync(join(dir, "bin", "entrypoint.sh")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(dir, COMPLETE))).toBe(false);
    const record: unknown = JSON.parse(readFileSync(join(dir, DEPLOY_RECORD), "utf8"));
    expect(record).toEqual({ commit: COMMIT, composeFile: "compose.yaml", deployedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(calls.at(-1)).toEqual({ args: ["compose", "-p", "shop", "-f", join(dir, "compose.yaml"), "up", "-d", "--build", "--remove-orphans"], cwd: dir });
});

test("a path whose kind differs between the stack's folder and the repository stops the copy before it writes anything", async () => {
    const dir = join(stacksRoot(), "notes");
    const elsewhere = mkdtempSync(join(tmpdir(), "stack-data-"));
    write(join(elsewhere, "keep.txt"), "the owner's disk");
    mkdirSync(dir, { recursive: true });
    // The owner moved the data to another disk and linked it; a container left a link where the repository has a file.
    symlinkSync(elsewhere, join(dir, "data"));
    symlinkSync("/etc/hostname", join(dir, "motd"));
    write(join(dir, "compose.yaml"), "services: { old: {} }\n");
    const source = pushed({ "compose.yaml": "services: { new: {} }\n", "data/seed.sql": "insert", motd: "hello" });
    const { docker, calls } = fakeDocker();

    const failure = await deployStack(deploy(source, "notes"), granted, SANDBOX, docker).catch(String);

    expect(failure).toContain(`Nothing was copied into ${dir}`);
    expect(failure).toContain("data (a link in the stack's folder, a folder in the repository)");
    expect(failure).toContain("motd (a link in the stack's folder, a file in the repository)");
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toBe("services: { old: {} }\n");
    expect(existsSync(join(elsewhere, "seed.sql"))).toBe(false);
    expect(readlinkSync(join(dir, "motd"))).toBe("/etc/hostname");
    expect(calls.filter((call) => call.args.includes("up"))).toEqual([]);
});

test("the copy recreates the repository's links as links and never follows one, in the repository or in the folder", async () => {
    const dest = mkdtempSync(join(tmpdir(), "stack-dest-"));
    const source = pushed({ "compose.yaml": "services: {}\n", "docs/readme.md": "hi" });
    symlinkSync("docs/readme.md", join(source, "README.md"));
    symlinkSync("/etc", join(source, "etc"));
    // An earlier deploy's link of the same name is replaced; nothing is written where it leads.
    symlinkSync("old-target", join(dest, "README.md"));

    const plan = await planCopy(source, dest);

    expect(plan.clashes).toEqual([]);
    expect(plan.steps).toEqual([
        { kind: "file", from: join(source, "compose.yaml"), to: join(dest, "compose.yaml") },
        { kind: "folder", to: join(dest, "docs") },
        { kind: "file", from: join(source, "docs", "readme.md"), to: join(dest, "docs", "readme.md") },
        { kind: "link", target: "/etc", to: join(dest, "etc"), replaces: false },
        { kind: "link", target: "docs/readme.md", to: join(dest, "README.md"), replaces: true },
    ]);

    await copyIntoStack(source, dest);
    expect(readlinkSync(join(dest, "README.md"))).toBe("docs/readme.md");
    expect(readlinkSync(join(dest, "etc"))).toBe("/etc");
    expect(lstatSync(join(dest, "docs")).isDirectory()).toBe(true);
    expect(existsSync(join(dest, "old-target"))).toBe(false);
});

test("a compose file missing from the push, or an `up` that fails, is an error, the second carrying compose's output", async () => {
    const { docker } = fakeDocker({ compose: { status: 1, stdout: "", stderr: "failed to solve: process \"/bin/sh -c npm ci\" did not complete successfully: exit code: 1\n" } });
    const noFile = pushed({ "docker-compose.yml": "services: {}\n" });
    await expect(deployStack(deploy(noFile, "nofile"), granted, SANDBOX, docker)).rejects.toThrow("There is no compose file at compose.yaml in the pushed repository.");
    expect(existsSync(join(stacksRoot(), "nofile"))).toBe(false);

    const dir = join(stacksRoot(), "broken");
    await expect(deployStack(deploy(pushed({ "compose.yaml": "services: {}\n" }), "broken"), granted, SANDBOX, docker)).rejects.toThrow(
        `docker compose up for broken in ${dir} failed (exit 1).\n\nfailed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`,
    );
});

test("a name another compose project already runs under is refused, and nothing is copied", async () => {
    const ps = JSON.stringify({ container: "blog-web-1", image: "ghost:6", state: "running", status: "Up 2 days", project: "blog", service: "web", workingDir: "/home/me/blog", configFiles: "/home/me/blog/compose.yaml", kind: "" });
    const { docker, calls } = fakeDocker({ ls: dockerAnswered(JSON.stringify([{ Name: "blog", Status: "running(1)", ConfigFiles: "/home/me/blog/compose.yaml" }])), ps: dockerAnswered(ps) });

    await expect(deployStack(deploy(pushed({ "compose.yaml": "services: {}\n" }), "blog"), granted, SANDBOX, docker)).rejects.toThrow(
        'A compose project called "blog" already runs on this device from /home/me/blog, which no deploy put there: deploying under its name would replace its containers. Deploy under another name.',
    );
    expect(existsSync(join(stacksRoot(), "blog"))).toBe(false);
    expect(calls.filter((call) => call.args.includes("up"))).toEqual([]);
});

test("stack_action runs in the stack's own folder with its files, and a pull's up shares the pull's output", async () => {
    const dir = join(stacksRoot(), "wiki");
    write(join(dir, "compose.yaml"), "services: { wiki: { image: 'wiki:2' } }\n");
    const files = join(dir, "compose.yaml");
    const ps = JSON.stringify({ container: "wiki-wiki-1", image: "wiki:2", state: "running", status: "Up 1 hour", project: "wiki", service: "wiki", workingDir: dir, configFiles: files, kind: "" });
    const { docker, calls } = fakeDocker({
        ls: dockerAnswered(JSON.stringify([{ Name: "wiki", Status: "running(1)", ConfigFiles: files }])),
        ps: dockerAnswered(ps),
        compose: dockerAnswered("", " wiki Pulled\n"),
    });

    expect(await stackAction("wiki", "pull", granted, docker)).toBe(" wiki Pulled\n wiki Pulled");
    expect(calls.slice(-2)).toEqual([
        { args: ["compose", "-p", "wiki", "-f", files, "pull"], cwd: dir },
        { args: ["compose", "-p", "wiki", "-f", files, "up", "-d", "--remove-orphans"], cwd: dir },
    ]);
});
