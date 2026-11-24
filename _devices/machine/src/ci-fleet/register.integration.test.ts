import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, fakeSys, type FakeRunner, runnerFiles, runnerPrograms, tempDir, testContext } from "./ci-fleet-testing.js";
import { accountFor, homeOf, registerRunner, type ReleaseSource, removeRunner, shaFromNotes } from "./register.js";

/* Registering and removing a runner on a fake computer: the release checked before anything is unpacked, config.sh run
   as the runner's account in its new folder, the unit installed through the runner's own svc.sh, and the token said
   nowhere a person or a log would read it. */

const TOKEN = "AABBCCDDEEFFGGHHIIJJKKLLMMNNOO";
const TARBALL = new TextEncoder().encode("a runner release");
const SHA = createHash("sha256").update(TARBALL).digest("hex");

const source = (sha256 = SHA): ReleaseSource & { asked: (string | undefined)[] } => {
    const asked: (string | undefined)[] = [];
    return {
        asked,
        release: async (version) => {
            asked.push(version);
            return await Promise.resolve({ version: version ?? "2.330.0", url: "https://example.invalid/runner.tar.gz", sha256 });
        },
        download: async () => await Promise.resolve(TARBALL),
    };
};

const args = { url: "https://github.com/intentic/intentic", token: TOKEN, name: "z440-worker-4", labels: ["intentic", "desktop"] };

const computer = (home: string, runners: FakeRunner[], configStatus = 0) =>
    fakeSys({
        programs: runnerPrograms(runners, (command, argv) => {
            if (command === "getent") {
                return exec(`radarsu:x:1000:1000::${home}:/bin/bash\n`);
            }
            if (command === "runuser" && argv.includes("./config.sh")) {
                return exec(configStatus === 0 ? "√ Runner successfully added" : `Http response code: Unauthorized from 'POST …' (token ${TOKEN})`, configStatus);
            }
            return command === "chown" || command === "runuser" || command === "./svc.sh" ? exec("") : undefined;
        }),
        files: runnerFiles(runners),
        links: new Map(runners.map((runner) => [join(runner.dir, "bin"), "bin.2.329.0"])),
    });

test("the release notes' SHA-256 is read per architecture, and an account and home are found", () => {
    const notes = `## SHA\n<!-- BEGIN SHA linux-x64 -->${"a".repeat(64)}<!-- END SHA linux-x64 -->\n<!-- BEGIN SHA linux-arm64 -->${"b".repeat(64)}<!-- END SHA linux-arm64 -->`;
    expect(shaFromNotes(notes, "x64")).toBe("a".repeat(64));
    expect(shaFromNotes(notes, "arm64")).toBe("b".repeat(64));
    expect(shaFromNotes("no sums here", "x64")).toBeUndefined();
    expect(homeOf("radarsu:x:1000:1000:Radarsu:/home/radarsu:/usr/bin/zsh")).toBe("/home/radarsu");
    const runners = [{ user: "radarsu" }, { user: "radarsu" }, { user: "ci" }].map((r) => ({ ...r, name: "x", unit: "u", dir: "d", light: false, state: "active" as const, busy: false, draining: false }));
    expect(accountFor(undefined, runners, "root")).toBe("radarsu");
    expect(accountFor("ci", runners, "root")).toBe("ci");
    expect(accountFor(undefined, [], "root")).toBe("root");
});

test("a registration unpacks the release the runners here run, configures it as their account and installs its unit", async () => {
    const home = tempDir("ci-fleet-home-");
    const runners: FakeRunner[] = [{ unit: "actions.runner.intentic-intentic.z440-worker-1.service", dir: join(home, "actions-runner-1"), name: "z440-worker-1", user: "radarsu" }];
    const sys = computer(home, runners);
    const { context } = await testContext(sys);
    const releases = source();
    const said = await registerRunner(context, args, releases);
    expect(said).toMatch(/Registered z440-worker-4 \(runner v2\.329\.0\).*running as radarsu/u);
    expect(releases.asked).toEqual(["2.329.0"]);
    const dir = join(home, "actions-runner-z440-worker-4");
    expect(existsSync(dir)).toBe(true);
    const steps = sys.calls.filter((call) => ["runuser", "./svc.sh", "chown"].includes(call[0] ?? "")).map((call) => call.slice(0, 5).join(" "));
    expect(steps).toEqual([`chown radarsu: ${dir}`, "runuser -u radarsu -- tar", "runuser -u radarsu -- ./config.sh", "./svc.sh install radarsu", "./svc.sh start"]);
    expect(sys.calls.find((call) => call.includes("./config.sh"))).toEqual(expect.arrayContaining(["--labels", "intentic,desktop", "--name", "z440-worker-4"]));
});

test("a tarball that is not the one the release published is refused before anything is unpacked", async () => {
    const home = tempDir("ci-fleet-home-");
    const sys = computer(home, []);
    const { context } = await testContext(sys);
    await expect(registerRunner(context, args, source("0".repeat(64)))).rejects.toThrow(/not the one its release published/u);
    expect(sys.calls.some((call) => call[0] === "runuser")).toBe(false);
});

test("a name already here, or a folder already there, is refused; a failed config.sh never says the token", async () => {
    const home = tempDir("ci-fleet-home-");
    const runners: FakeRunner[] = [{ unit: "actions.runner.intentic-intentic.z440-worker-4.service", dir: join(home, "actions-runner-4"), name: "z440-worker-4" }];
    const taken = await testContext(computer(home, runners));
    await expect(registerRunner(taken.context, args, source())).rejects.toThrow(/already on this computer/u);
    const failing = await testContext(computer(home, [], 1));
    const error = await registerRunner(failing.context, args, source()).catch((caught: Error) => caught);
    expect(String(error)).toMatch(/config\.sh did not register.*Unauthorized/u);
    expect(String(error)).not.toContain(TOKEN);
});

test("removal refuses a busy runner; an idle one is unregistered, its unit uninstalled and its folder trashed", async () => {
    const home = tempDir("ci-fleet-home-");
    const dir = join(home, "actions-runner-2");
    mkdirSync(dir);
    writeFileSync(join(dir, "marker"), "x");
    const busy: FakeRunner[] = [{ unit: "actions.runner.intentic-intentic.z440-worker-2.service", dir, name: "z440-worker-2", worker: 5 }];
    const working = await testContext(computer(home, busy));
    await expect(removeRunner(working.context, { name: "z440-worker-2", token: TOKEN })).rejects.toThrow(/running a job: drain it first/u);
    const idle: FakeRunner[] = [{ unit: busy[0]?.unit ?? "", dir, name: "z440-worker-2", user: "radarsu" }];
    const sys = computer(home, idle);
    const { context } = await testContext(sys);
    expect(await removeRunner(context, { name: "z440-worker-2", token: TOKEN })).toMatch(/Removed z440-worker-2/u);
    expect(sys.calls.filter((call) => call[0] === "./svc.sh").map((call) => call[1])).toEqual(["stop", "uninstall"]);
    expect(existsSync(dir)).toBe(false);
});
