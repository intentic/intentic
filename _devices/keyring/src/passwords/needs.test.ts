import { seal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { type FakeSandbox, fakeSandbox, type Harness, keyringHarness, TEST_PASSPHRASE } from "../testing.js";

// An agent's need, asked by where the password is used: matched by place, chosen and confirmed by the person, shared on
// the terms they chose; nothing about an entry that does not match or one they refuse reaches the sandbox; a need nobody
// answers waits under Requests until the app answers it; and an unmatched need typed once is kept and shared.

const GITHUB: KeyringOrigin = { kind: "site", host: "github.com" };
const NEED = { origin: GITHUB, detail: "push the release branch", purpose: "agent", typeOnce: false } as const;

const inboxOf = async (h: Harness): Promise<string> => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state) || state.state.keys === undefined) {
        throw new Error("no inbox key");
    }
    return state.state.keys.inbox;
};

// Set up with github.com saved for radarsu (a browser capture), unlocked, nobody asked yet.
const withGithub = async (): Promise<{ h: Harness; sandbox: FakeSandbox }> => {
    const sandbox = fakeSandbox();
    const h = keyringHarness([sandbox]);
    await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
    await h.keyring.handle({ op: "set-settings", patch: { remember: { browser: true } } });
    const at = h.clock.now;
    const sealed = seal(await inboxOf(h), "github-password-1", { kind: "capture", via: "Brave", at });
    await h.keyring.handle({ op: "capture", item: { origin: GITHUB, username: "radarsu", sealed, source: "browser", via: "Brave", kind: "password", at } });
    h.person.asked.length = 0;
    return { h, sandbox };
};

const sharesOf = async (h: Harness, sandbox: string) => {
    const shares = await h.keyring.handle({ op: "shares", sandbox });
    if (!shares.ok || !("pointers" in shares)) {
        throw new Error("no shares");
    }
    return shares.pointers;
};

describe("an agent's need", () => {
    test("a match is shared on the terms the person chose, after their verified yes", async () => {
        const { h, sandbox } = await withGithub();
        h.person.choices.push("while-here");
        const answer = await h.keyring.handle({ op: "need", sandbox: sandbox.url, need: NEED });
        expect(answer).toMatchObject({ ok: true, pointer: { name: "GITHUB_COM", mode: "while-here" }, saved: false });
        expect(h.person.dialogs[0]?.message).toContain("push the release branch");
        expect(h.person.asked).toHaveLength(1);
        expect((await sharesOf(h, sandbox.url)).map((pointer) => pointer.name)).toEqual(["GITHUB_COM"]);
        expect(JSON.stringify(answer)).not.toContain("github-password-1");
    });

    test("Deny shares nothing, and says nothing of what was there", async () => {
        const { h, sandbox } = await withGithub();
        h.person.choices.push("deny");
        expect(await h.keyring.handle({ op: "need", sandbox: sandbox.url, need: NEED })).toMatchObject({ ok: false, code: "declined" });
        expect(await sharesOf(h, sandbox.url)).toEqual([]);
    });

    test("nothing that fits is `unknown` at once, with no prompt, so the next computer can be asked", async () => {
        const { h, sandbox } = await withGithub();
        expect(await h.keyring.handle({ op: "need", sandbox: sandbox.url, need: { ...NEED, origin: { kind: "site", host: "gitlab.com" } } })).toMatchObject({ ok: false, code: "unknown" });
        expect(h.person.asked).toEqual([]);
        expect(h.person.boxes).toEqual([]);
    });

    test("with typeOnce, the value typed in the keyring's box is kept here and shared", async () => {
        const { h, sandbox } = await withGithub();
        h.person.typed.push({ kind: "answered", value: "gitlab-password-1", remember: true, username: "radar" });
        h.person.choices.push("once");
        const answer = await h.keyring.handle({ op: "need", sandbox: sandbox.url, need: { ...NEED, origin: { kind: "site", host: "gitlab.com" }, typeOnce: true } });
        expect(answer).toMatchObject({ ok: true, pointer: { name: "GITLAB_COM", mode: "each-use" }, saved: true });
        expect(JSON.stringify(h.files.vault)).not.toContain("gitlab-password-1");
    });

    test("a need nobody answers waits under Requests, and the app's answer shares it", async () => {
        const { h, sandbox } = await withGithub();
        h.person.replies.push("away");
        expect(await h.keyring.handle({ op: "need", sandbox: sandbox.url, need: NEED })).toMatchObject({ ok: false, code: "pending" });
        const waiting = await h.keyring.handle({ op: "needs" });
        if (!waiting.ok || !("pending" in waiting) || !Array.isArray(waiting.pending)) {
            throw new Error("no needs");
        }
        expect(waiting.pending).toMatchObject([{ sandbox: sandbox.url, matches: ["GITHUB_COM"], need: { detail: "push the release branch" } }]);
        const [pending] = waiting.pending;
        expect(await h.keyring.handle({ op: "answer-need", id: pending?.id ?? "", answer: "always" })).toEqual({ ok: true });
        expect(await sharesOf(h, sandbox.url)).toMatchObject([{ name: "GITHUB_COM", mode: "copy" }]);
        expect(await h.keyring.handle({ op: "needs" })).toEqual({ ok: true, pending: [] });
    });
});
