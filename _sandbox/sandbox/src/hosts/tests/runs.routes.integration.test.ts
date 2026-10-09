import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { TerminalRunner, TerminalRunOptions } from "../../terminal/terminal-run.js";
import { createRunGrants } from "../device-door.js";
import { createRunsRoutes, readRunTargets, runSession } from "../runs.routes.js";

// The editor's "Run on <device>": what each repository declares, read off its own file, and a run that is the same
// `devices run` an agent types, in a terminal, holding a grant for its one computer while it lasts.

const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "runs-routes-"));
    mkdirSync(join(root, "app", ".git"), { recursive: true });
    mkdirSync(join(root, "app", STATE_DIR), { recursive: true });
    writeFileSync(
        join(root, "app", RUN_TARGETS_FILE),
        JSON.stringify({ targets: [{ name: "desktop", device: "rog", build: "make win", artifact: { "app.exe": "out/app.exe" }, program: "app.exe" }] }),
    );
    mkdirSync(join(root, "broken", ".git"), { recursive: true });
    mkdirSync(join(root, "broken", STATE_DIR), { recursive: true });
    writeFileSync(join(root, "broken", RUN_TARGETS_FILE), JSON.stringify({ targets: [{ name: "../x", artifact: "/etc/passwd" }] }));
    mkdirSync(join(root, "quiet", ".git"), { recursive: true });
    return root;
};

test("each repository's file is read as it is: its targets, what is wrong with it, nothing for one without", async () => {
    const repos = await readRunTargets(workspace());
    expect(repos.map((entry) => entry.repo).toSorted()).toEqual(["app", "broken"]);
    const app = repos.find((entry) => entry.repo === "app");
    expect(app).toMatchObject({ path: "app/.intentic/run.json", targets: [{ name: "desktop", device: "rog", args: [], reach: [], isolated: false }] });
    const broken = repos.find((entry) => entry.repo === "broken");
    expect(broken?.targets).toEqual([]);
    expect(broken?.error).toContain("artifact");
});

const runner = () => {
    const ran: { session: string; command: string; cwd: string | undefined; grant: string | undefined }[] = [];
    let finish: () => void = () => {};
    const fake: TerminalRunner = {
        running: () => false,
        run: async () => "",
        tryRun: async (session: string, command: string, options: TerminalRunOptions) => {
            ran.push({ session, command, cwd: options.cwd, grant: options.env?.["INTENTIC_RUN_GRANT"] });
            options.onStarted?.();
            await new Promise<void>((done) => {
                finish = done;
            });
            return { code: 0, output: "" };
        },
    } as unknown as TerminalRunner;
    return { fake, ran, finish: () => finish() };
};

const routes = (root: string, online: boolean, features: string[], terminal: TerminalRunner, grants = createRunGrants()) =>
    createRunsRoutes(
        {
            workspace: { root },
            logger: { warn: () => {} },
            runGrants: grants,
            capabilities: { list: async () => [{ id: "rog", kind: "device", config: { programs: "on" } }, { id: "omen", kind: "device", config: { programs: "off" } }] },
            hostHub: { state: (id: string) => ({ online: online && id === "rog", facts: { features } }) },
        } as unknown as Pick<Services, "capabilities" | "hostHub" | "runGrants" | "workspace" | "logger">,
        terminal,
    );

const call = async <T>(procedure: unknown, input?: unknown): Promise<T> =>
    // oxlint-disable-next-line typescript/no-unsafe-call -- the implemented procedure's handler, called as oRPC would
    (await (procedure as { "~orpc": { handler: (options: unknown) => Promise<T> } })["~orpc"].handler({ input, context: {}, path: [], procedure, signal: undefined, lastEventId: undefined, errors: {} }));

test("the list says which computers could take a run now, and why not", async () => {
    const { fake } = runner();
    const listed = await call<{ devices: unknown[] }>(routes(workspace(), true, ["programs"], fake).targets);
    expect(listed.devices).toEqual([
        { id: "rog", online: true, programs: true, allowed: true },
        { id: "omen", online: false, programs: false, allowed: false },
    ]);
});

test("a run is `devices run` in a job terminal from the repository, with a grant that ends when the run does", async () => {
    const root = workspace();
    const grants = createRunGrants();
    const { fake, ran, finish } = runner();
    const started = await call<{ session: string }>(routes(root, true, ["programs"], fake, grants).start, { repo: "app", target: "desktop", device: "rog" });
    expect(started.session).toBe(runSession("app", "desktop", "rog"));
    expect(started.session.startsWith("job-")).toBe(true);
    expect(ran).toEqual([{ session: started.session, command: "devices run desktop --device rog", cwd: join(root, "app"), grant: expect.any(String) }]);
    const grant = ran[0]?.grant ?? "";
    expect(grants.allows(grant, "rog")).toBe(true);
    finish();
    await new Promise((done) => setTimeout(done, 0));
    expect(grants.allows(grant, "rog")).toBe(false);
});

test("a target nobody declared, and a computer that cannot take it, are refused before any terminal opens", async () => {
    const { fake, ran } = runner();
    await expect(call(routes(workspace(), true, ["programs"], fake).start, { repo: "app", target: "nope", device: "rog" })).rejects.toThrow("no run target");
    await expect(call(routes(workspace(), false, ["programs"], fake).start, { repo: "app", target: "desktop", device: "rog" })).rejects.toThrow("not connected");
    await expect(call(routes(workspace(), true, [], fake).start, { repo: "app", target: "desktop", device: "rog" })).rejects.toThrow("too old");
    expect(ran).toEqual([]);
});
