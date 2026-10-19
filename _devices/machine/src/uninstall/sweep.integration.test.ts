import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { tally } from "./tally.js";

/* The purge's last step on a real tree: a home of the test's own, redirected before the agent's paths are read (as
   device/config.integration.test.ts redirects it). The guard below refuses to sweep anything if those paths were read
   earlier from the real home, so this suite can never remove the files of whoever runs it. */

const realHome = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
let home: string;
let files: typeof import("./sweep.js");
let config: typeof import("../config.js");

const said: string[] = [];
const say = tally({ note: (text) => said.push(text), warn: (text) => said.push(text) });

const STAMP = "2026-10-05T22-45-00-000Z";

const put = async (path: string, text = "x"): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
};

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "intentic-machine-purge-"));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    config = await import("../config.js");
    files = await import("./sweep.js");
    if (!config.baseDir.startsWith(home)) {
        throw new Error(`the agent's folder was read before HOME was redirected (${config.baseDir}): refusing to sweep a real home`);
    }
});

afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    for (const [name, value] of Object.entries(realHome)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

// A device as an agent leaves it: binaries, state, logs, the person's data, and ic's own folder beside the agent's.
const device = async (): Promise<void> => {
    const machine = join(home, STATE_DIR, "machine");
    const keyring = join(home, STATE_DIR, "keyring");
    await put(join(machine, "bin", "intentic-machine"));
    await put(join(machine, "bin", "mutagen"));
    await put(join(machine, "mutagen", "daemon", "daemon.lock"));
    await put(join(machine, "machine.log"));
    await put(join(machine, "device.json"));
    await put(join(machine, "runs", "sandbox-ab12", "apps.json"), "[]");
    await put(join(machine, "restore", "key", "point", "manifest.json"));
    await put(join(machine, "audit.jsonl"));
    await put(join(machine, "audit.jsonl.1"));
    await put(join(machine, "trash", STAMP, "notes.txt"));
    await put(join(machine, "trash", `${STAMP}-sync`, "big"));
    await put(join(keyring, "vault.json"));
    await put(join(keyring, "keys.json"));
    await put(join(keyring, "keyring.log"));
    await put(join(home, STATE_DIR, "bin", "ic"));
};

const sorted = async (dir: string): Promise<string[]> => (await readdir(dir)).toSorted();

test("a purge keeps the person's data and ic's folder, and removes everything else of the agent's", async () => {
    await device();
    const swept = await files.sweepAgentFiles(false, false, say);
    const machine = join(home, STATE_DIR, "machine");
    expect(await sorted(machine)).toEqual(["audit.jsonl", "audit.jsonl.1", "restore", "trash"]);
    expect(await sorted(join(machine, "trash"))).toEqual([STAMP]);
    expect(await sorted(join(home, STATE_DIR, "keyring"))).toEqual(["keys.json", "vault.json"]);
    expect(existsSync(join(home, STATE_DIR, "bin", "ic"))).toBe(true);
    expect(swept.stuck).toEqual([]);
    expect(swept.keyringData.toSorted()).toEqual(["keys.json", "vault.json"]);
    expect(swept.machineData).toContain(`trash/${STAMP}`);
});

test("--delete-data takes the data too, and ~/.intentic goes once nothing of ic's is in it either", async () => {
    await device();
    await files.sweepAgentFiles(true, false, say);
    expect(await sorted(join(home, STATE_DIR))).toEqual(["bin"]);
    await rm(join(home, STATE_DIR, "bin"), { recursive: true });
    await device();
    await rm(join(home, STATE_DIR, "bin"), { recursive: true });
    await files.sweepAgentFiles(true, false, say);
    expect(existsSync(join(home, STATE_DIR))).toBe(false);
});

test("a step that needs the agent's programs to be finished keeps bin", async () => {
    await device();
    await files.sweepAgentFiles(true, true, say);
    expect(await sorted(join(home, STATE_DIR, "machine"))).toEqual(["bin"]);
    await rm(join(home, STATE_DIR), { recursive: true, force: true });
});

test("the binary is set aside before anything stops the agent, so a supervisor's restart finds no agent", async () => {
    await device();
    await files.setAgentAside();
    expect(existsSync(join(home, STATE_DIR, "machine", "bin", "intentic-machine"))).toBe(false);
    expect(existsSync(files.asidePath)).toBe(true);
    await rm(join(home, STATE_DIR), { recursive: true, force: true });
});
