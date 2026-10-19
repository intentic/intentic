import { seal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringCaptureItem, KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { UNDO_WINDOW_MS } from "./capture.js";
import { fakeSandbox, type Harness, keyringHarness, TEST_PASSPHRASE } from "../testing.js";

// Capture end to end through the pipe's ops: a credential seen in use is kept without asking once its source's switch
// is on, named and placed from where it was seen, updated with its old value kept, replaced when it failed, held sealed
// while locked, and taken back by the notice's Undo. Nothing it does shares a value or shows one.

const BUILD: KeyringOrigin = { kind: "ssh", target: "radar@build-01" };
const GITHUB: KeyringOrigin = { kind: "site", host: "github.com" };

const inboxOf = async (h: Harness): Promise<string> => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state) || state.state.keys === undefined) {
        throw new Error("no inbox key");
    }
    return state.state.keys.inbox;
};

const setUp = async (remember: Partial<Record<"browser" | "terminal" | "apps" | "phone" | "sandbox", boolean>> = {}): Promise<Harness> => {
    const h = keyringHarness([]);
    expect(await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false })).toEqual({ ok: true });
    if (Object.keys(remember).length > 0) {
        expect(await h.keyring.handle({ op: "set-settings", patch: { remember } })).toMatchObject({ ok: true });
    }
    h.person.asked.length = 0;
    return h;
};

let tick = 0;
const itemOf = async (h: Harness, origin: KeyringOrigin, value: string, over: Partial<Omit<KeyringCaptureItem, "sealed">> = {}): Promise<KeyringCaptureItem> => {
    tick += 1;
    const draft = { origin, source: "askpass" as const, via: "ssh", kind: "password" as const, at: h.clock.now + tick, ...over };
    return { ...draft, sealed: seal(await inboxOf(h), value, { kind: "capture", via: draft.via, at: draft.at }) };
};

const entries = async (h: Harness) => {
    const listed = await h.keyring.handle({ op: "list" });
    if (!listed.ok || !("entries" in listed)) {
        throw new Error("no list");
    }
    return listed.entries;
};

describe("capture", () => {
    test("with remembering off for its source, nothing is kept", async () => {
        const h = await setUp();
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, BUILD, "build-password-1") })).toEqual({ ok: true, outcome: "skipped" });
        expect(await entries(h)).toEqual([]);
    });

    test("turning a source on asks; turning it off does not", async () => {
        const h = await setUp();
        await h.keyring.handle({ op: "set-settings", patch: { remember: { terminal: true } } });
        expect(h.person.asked).toHaveLength(1);
        await h.keyring.handle({ op: "set-settings", patch: { remember: { terminal: false } } });
        expect(h.person.asked).toHaveLength(1);
    });

    test("a new credential is kept unasked, named and placed from where it was seen", async () => {
        const h = await setUp({ terminal: true });
        const answer = await h.keyring.handle({ op: "capture", item: await itemOf(h, BUILD, "build-password-1", { username: "radar" }) });
        expect(answer).toEqual({ ok: true, outcome: "saved", name: "SSH_RADAR_BUILD_01", title: "ssh radar@build-01" });
        expect(h.person.asked).toEqual([]);
        const [entry] = await entries(h);
        expect(entry).toMatchObject({ name: "SSH_RADAR_BUILD_01", askpass: ["ssh:radar@build-01"], username: "radar", fresh: true, unverified: true, captured: { source: "askpass", via: "ssh" } });
        expect(JSON.stringify(await entries(h))).not.toContain("build-password-1");
        expect(JSON.stringify(h.files.vault)).not.toContain("build-password-1");
    });

    test("a new value for the same place and account keeps the old one in its history; the same value changes nothing", async () => {
        const h = await setUp({ browser: true });
        const browser = { source: "browser" as const, via: "Brave", username: "radarsu" };
        await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "first-password-1", browser) });
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, { kind: "site", host: "www.github.com" }, "second-password-2", browser) })).toMatchObject({ outcome: "updated", name: "GITHUB_COM" });
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "second-password-2", browser) })).toMatchObject({ outcome: "unchanged" });
        expect(await h.keyring.handle({ op: "history", name: "GITHUB_COM" })).toMatchObject({ ok: true, versions: [{ version: 0 }] });
        // Another account at the same site is an entry of its own.
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "work-password-3", { ...browser, username: "radar-work" }) })).toMatchObject({ outcome: "saved", name: "GITHUB_COM_RADAR_WORK" });
    });

    test("a value that failed is replaced, not kept as history", async () => {
        const h = await setUp({ terminal: true });
        await h.keyring.handle({ op: "capture", item: await itemOf(h, BUILD, "mistyped-password") });
        await h.keyring.handle({ op: "capture", item: await itemOf(h, BUILD, "right-password-1", { failed: true }) });
        expect(await h.keyring.handle({ op: "history", name: "SSH_RADAR_BUILD_01" })).toMatchObject({ ok: true, versions: [] });
    });

    test("a place on the never-save list is skipped", async () => {
        const h = await setUp({ browser: true });
        await h.keyring.handle({ op: "set-settings", patch: { neverSave: [GITHUB] } });
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "never-kept-1", { source: "browser", via: "Brave" }) })).toMatchObject({ outcome: "skipped" });
    });

    test("while locked a capture waits sealed, and the next unlock takes it in", async () => {
        const h = await setUp({ terminal: true });
        const item = await itemOf(h, BUILD, "build-password-1");
        await h.keyring.handle({ op: "lock" });
        expect(await h.keyring.handle({ op: "capture", item })).toEqual({ ok: true, outcome: "pending" });
        expect(await h.keyring.handle({ op: "state" })).toMatchObject({ ok: true, state: { pendingCaptures: 1 } });
        expect(JSON.stringify(h.files.vault)).not.toContain("build-password-1");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        expect((await entries(h)).map((entry) => entry.name)).toEqual(["SSH_RADAR_BUILD_01"]);
        expect(await h.keyring.handle({ op: "state" })).toMatchObject({ ok: true, state: { pendingCaptures: 0 } });
    });

    test("a sandbox speaks only for a phone or a terminal", async () => {
        const h = await setUp({ browser: true, sandbox: true });
        const sandbox = fakeSandbox().url;
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "from-a-sandbox-1", { source: "browser", via: "Brave" }), sandbox })).toMatchObject({ ok: false, code: "bad-grant" });
        const prompt: KeyringOrigin = { kind: "prompt", text: "Password:", command: "npm login" };
        expect(await h.keyring.handle({ op: "capture", item: await itemOf(h, prompt, "npm-password-1", { source: "terminal", via: "intentic-dev" }), sandbox })).toMatchObject({ ok: true, outcome: "saved", title: "npm login" });
    });

    test("a flood is cut off", async () => {
        const h = await setUp({ terminal: true });
        const answers = [];
        for (let n = 0; n < 61; n++) {
            answers.push(await h.keyring.handle({ op: "capture", item: await itemOf(h, { kind: "ssh", target: `u@host-${String(n)}` }, `password-number-${String(n)}`) }));
        }
        expect(answers.at(-1)).toMatchObject({ ok: false, code: "busy" });
        expect(answers.at(-2)).toMatchObject({ ok: true, outcome: "saved" });
    });

    test("Undo takes back a new entry, and only for ten minutes", async () => {
        const h = await setUp({ terminal: true });
        const first = await itemOf(h, BUILD, "build-password-1");
        await h.keyring.handle({ op: "capture", item: first });
        expect(await h.keyring.handle({ op: "undo-capture", name: "SSH_RADAR_BUILD_01", at: first.at + 1 })).toMatchObject({ ok: false, code: "unknown" });
        expect(await h.keyring.handle({ op: "undo-capture", name: "SSH_RADAR_BUILD_01", at: first.at })).toEqual({ ok: true });
        expect(await entries(h)).toEqual([]);
        const second = await itemOf(h, BUILD, "build-password-2");
        await h.keyring.handle({ op: "capture", item: second });
        h.clock.now += UNDO_WINDOW_MS + 1000;
        await h.keyring.handle({ op: "unlock", minutes: 60 });
        expect(await h.keyring.handle({ op: "undo-capture", name: "SSH_RADAR_BUILD_01", at: second.at })).toMatchObject({ ok: false, code: "unknown" });
    });

    test("a browser fill gets a value only for an entry that serves its site, and only at a yes", async () => {
        const h = await setUp({ browser: true });
        await h.keyring.handle({ op: "capture", item: await itemOf(h, GITHUB, "github-password-1", { source: "browser", via: "Brave", username: "radarsu" }) });
        h.person.asked.length = 0;
        expect(await h.keyring.handle({ op: "fill-value", origin: { kind: "site", host: "evil.example" }, name: "GITHUB_COM" })).toMatchObject({ ok: false, code: "unknown" });
        expect(h.person.asked).toEqual([]);
        expect(await h.keyring.handle({ op: "fill-value", origin: { kind: "site", host: "gist.github.com" }, name: "GITHUB_COM" })).toEqual({ ok: true, value: "github-password-1", username: "radarsu" });
        expect(h.person.asked).toHaveLength(1);
        expect(await h.keyring.handle({ op: "candidates", origin: GITHUB })).toEqual({ ok: true, matches: [{ name: "GITHUB_COM", title: "github.com", username: "radarsu" }] });
    });

    test("an import asks once, then keeps every row", async () => {
        const h = await setUp();
        const first = await itemOf(h, GITHUB, "imported-password-1", { source: "import", via: "Chrome" });
        const rows = [first, await itemOf(h, { kind: "site", host: "linkedin.com" }, "imported-password-2", { source: "import", via: "Chrome" })];
        expect(await h.keyring.handle({ op: "capture-batch", items: rows, from: "Chrome" })).toEqual({ ok: true, saved: 2, updated: 0, unchanged: 0, skipped: 0 });
        expect(h.person.asked).toHaveLength(1);
        // An import is never a capture on its own.
        expect(await h.keyring.handle({ op: "capture", item: first })).toMatchObject({ ok: false, code: "bad-grant" });
    });

    test("seen clears Just saved", async () => {
        const h = await setUp({ terminal: true });
        await h.keyring.handle({ op: "capture", item: await itemOf(h, BUILD, "build-password-1") });
        await h.keyring.handle({ op: "seen", names: ["SSH_RADAR_BUILD_01"] });
        expect((await entries(h))[0]?.fresh).not.toBe(true);
    });
});
