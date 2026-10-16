import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { KEYRING_HOME, type KeyringRequest } from "@intentic/keyring";
import { run, type StricliProcess } from "@stricli/core";
import { fakeKeyring, type FakeKeyring, KEY_A, STATE } from "./keyring-testing.js";

// `intentic-machine keyring …` as the desktop app runs it, with --json on a pipe, against a keyring answering from a
// script in a temp HOME: the flags as typed on a command line, the request each one puts on the pipe, and the one JSON
// line that comes back. HOME names both the keyring's pipe and device.json, hence the dynamic import below.

const SANDBOX = "https://work.example.intentic.dev";

let home: string;
let keyring: FakeKeyring;
let app: typeof import("../app.js").app;

const ENTRY = {
    name: "GH_TOKEN",
    kind: "text",
    programs: [],
    packages: [],
    hosts: ["github.com"],
    anyField: true,
    askpass: ["git:https://github.com"],
    askpassRememberMinutes: 5,
    source: "1password",
    backend: { backend: "1password", ref: "op://Work/GitHub/token" },
    shares: [{ sandbox: SANDBOX, machine: "laptop", mode: "while-here", sharedAt: 1 }],
    createdAt: 1,
    updatedAt: 2,
};

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "keyring-cli-"));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    const machine = join(home, STATE_DIR, "machine");
    await mkdir(machine, { recursive: true });
    await writeFile(
        join(machine, "device.json"),
        JSON.stringify({ links: [{ sandboxUrl: SANDBOX, id: "laptop", token: "t", scopes: { shell: "off", write: "off", screen: "off", control: "off" } }] }),
    );
    const dir = join(home, STATE_DIR, KEYRING_HOME);
    await mkdir(dir, { recursive: true });
    keyring = await fakeKeyring(
        {
            state: () => ({ ok: true, state: STATE, setUp: true }),
            add: () => ({ ok: true }),
            edit: () => ({ ok: true }),
            share: () => ({ ok: true, fingerprint: "AB:CD:EF" }),
            unlock: (request) => ({ ok: true, unlockedUntil: 1_000 + (request.op === "unlock" ? request.minutes : 0) }),
            list: () => ({ ok: true, entries: [ENTRY], backends: ["1password"] }),
            "sync-state": () => ({ ok: true, sync: { key: KEY_A, peers: [], revision: 0 } }),
            lock: () => ({ ok: false, code: "busy", refusal: "Another prompt is open on this computer." }),
        },
        dir,
    );
    ({ app } = await import("../app.js"));
});

afterAll(async () => {
    await keyring.close();
    await rm(home, { recursive: true, force: true });
});

// One run on a pipe, as the desktop app makes it.
const cli = async (...argv: string[]): Promise<{ readonly out: string; readonly exitCode: unknown; readonly sent: KeyringRequest | undefined }> => {
    const out: string[] = [];
    const fake: StricliProcess = {
        stdout: { write: (chunk: string) => void out.push(chunk) },
        stderr: { write: () => undefined },
        env: { INTENTIC_UI: "plain", NO_COLOR: "1" },
    };
    const before = keyring.requests.length;
    await run(app, ["keyring", ...argv], { process: fake });
    return { out: out.join(""), exitCode: fake.exitCode, sent: keyring.requests.slice(before).findLast((request) => request.op !== "state") };
};

test("add takes repeatable rule flags and a password manager's reference, and sends no value for a backed entry", async () => {
    const { out, sent, exitCode } = await cli(
        "add",
        "GH_TOKEN",
        "--kind",
        "text",
        "--backend",
        "1password",
        "--ref",
        "op://Work/GitHub/token",
        "--program",
        "Code.exe",
        "--program",
        "git.exe",
        "--host",
        "github.com",
        "--askpass",
        "git:https://github.com",
        "--remember-minutes",
        "5",
        "--any-field",
        "--replace",
        "--json",
    );
    expect(exitCode).not.toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: true, name: "GH_TOKEN" });
    expect(sent).toEqual({
        op: "add",
        name: "GH_TOKEN",
        backend: { backend: "1password", ref: "op://Work/GitHub/token" },
        rules: {
            kind: "text",
            programs: ["Code.exe", "git.exe"],
            packages: [],
            hosts: ["github.com"],
            anyField: true,
            askpass: ["git:https://github.com"],
            askpassRememberMinutes: 5,
        },
        replace: true,
    });
});

test("edit sends only the rules given, a lone empty value emptying its list, and --any-field as on or off", async () => {
    const { out, sent } = await cli("edit", "GH_TOKEN", "--program", "", "--any-field", "off", "--json");
    expect(JSON.parse(out)).toEqual({ ok: true, name: "GH_TOKEN", valueChanged: false });
    expect(sent).toEqual({ op: "edit", name: "GH_TOKEN", patch: { programs: [], anyField: false } });
});

test("share names the link by its id, and the keyring is told that link's sandbox and card", async () => {
    const { out, sent } = await cli("share", "GH_TOKEN", "--sandbox", "laptop", "--mode", "while-here", "--json");
    expect(JSON.parse(out)).toEqual({ ok: true, name: "GH_TOKEN", sandbox: SANDBOX, machine: "laptop", mode: "while-here", fingerprint: "AB:CD:EF" });
    expect(sent).toEqual({ op: "share", name: "GH_TOKEN", sandbox: SANDBOX, machine: "laptop", mode: "while-here" });
});

test("a sandbox this computer is not linked to is a usage refusal, exit 1, and nothing reaches the keyring", async () => {
    const { out, sent, exitCode } = await cli("share", "GH_TOKEN", "--sandbox", "https://elsewhere.example", "--mode", "copy", "--json");
    expect(exitCode).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "usage", refusal: expect.stringContaining("laptop") });
    expect(sent).toBeUndefined();
});

test("list, unlock and sync status hand the keyring's answer through", async () => {
    expect(JSON.parse((await cli("list", "--json")).out)).toEqual({ ok: true, entries: [ENTRY], backends: ["1password"] });
    const unlocked = await cli("unlock", "--minutes", "30", "--json");
    expect(unlocked.sent).toEqual({ op: "unlock", minutes: 30 });
    expect(JSON.parse(unlocked.out)).toEqual({ ok: true, unlockedUntil: 1_030 });
    expect(JSON.parse((await cli("sync", "status", "--json")).out)).toEqual({ ok: true, sync: { key: KEY_A, peers: [], revision: 0 } });
});

test("a keyring's refusal is the one JSON line, with its code, and exit 1", async () => {
    const { out, exitCode } = await cli("lock", "--json");
    expect(exitCode).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: false, code: "busy", refusal: "Another prompt is open on this computer." });
});

test("status says the binary is not installed here but a keyring answers, set up, with askpass not pointed at it", async () => {
    const { out } = await cli("status", "--json");
    expect(JSON.parse(out)).toEqual({ ok: true, installed: false, running: true, setUp: true, state: STATE, askpass: { installed: false }, hardened: false });
});
