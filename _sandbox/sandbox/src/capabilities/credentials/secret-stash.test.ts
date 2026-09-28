import { type Capability, stashedMarker, stashedToken } from "@intentic/sandbox-contract";
import { sshHandler } from "../handlers/ssh.handler.js";
import { secretFieldsOf } from "./secret-fields.js";
import { createSecretStash, type SecretStash, spendStashed, StashRefusal, unstash } from "./secret-stash.js";
import { generateSshKey } from "./ssh-keys.js";

// generate → stash → resolve: the road a key the sandbox made for a form takes to the add that installs it. The
// browser only ever holds a token; the add trades it back for the key once, and a token nobody uses lapses.

const THIRTY_MINUTES = 30 * 60_000;

const clock = () => {
    let at = 1_700_000_000_000;
    return {
        now: () => at,
        pass: (ms: number) => {
            at += ms;
        },
    };
};

// What sshKey does with a pair: holds the private half for the one place it may go.
const stashKey = (stash: SecretStash, privateKey: string): string => stash.put({ kind: "ssh", field: "privateKey", value: privateKey });

// The ssh form as the browser sends it: the marker where the private key goes.
const form = (token: string) => ({
    auth: "generated",
    host: "box.example.com",
    port: 22,
    user: "root",
    privateKey: stashedMarker(token),
});

test("a stashed key resolves to itself until the add stores it, and never after", () => {
    const stash = createSecretStash();
    const pair = generateSshKey("intentic-box");
    const token = stashKey(stash, pair.privateKey);

    expect(stashedToken(stashedMarker(token))).toBe(token);
    expect(unstash(stash, "ssh", form(token))).toEqual({ privateKey: pair.privateKey });
    // Looking is not using: a Test, or an add whose apply failed, leaves the key for the next try.
    expect(unstash(stash, "ssh", form(token))).toEqual({ privateKey: pair.privateKey });

    spendStashed(stash, form(token));
    expect(() => unstash(stash, "ssh", form(token))).toThrow(StashRefusal);
    expect(stash.peek(token)).toBeUndefined();
});

test("a token lapses thirty minutes after the key was made, used or not", () => {
    const { now, pass } = clock();
    const stash = createSecretStash({ now });
    const token = stashKey(stash, generateSshKey("c").privateKey);

    pass(THIRTY_MINUTES - 1);
    expect(unstash(stash, "ssh", form(token))).toEqual({ privateKey: expect.stringContaining("-----BEGIN OPENSSH PRIVATE KEY-----") });
    pass(1);
    expect(() => unstash(stash, "ssh", form(token))).toThrow("that generated key is no longer held");
});

test("a marker nothing is held behind is refused rather than written", () => {
    expect(() => unstash(createSecretStash(), "ssh", form("never-issued"))).toThrow(StashRefusal);
});

test("a config with no marker passes through untouched", () => {
    expect(unstash(createSecretStash(), "ssh", { auth: "key", host: "h", port: 22, user: "u", privateKey: "-----BEGIN…" })).toEqual({});
});

// An mcp token rides as a bearer to a URL the caller names: installing the key there would hand it to that host.
test("a key made for an ssh connection's private key is refused anywhere else", () => {
    const stash = createSecretStash();
    const token = stashKey(stash, generateSshKey("c").privateKey);
    expect(() => unstash(stash, "mcp", { url: "https://elsewhere.example/mcp", token: stashedMarker(token) })).toThrow(
        "that generated key was made to be the privateKey of a ssh entry, so it is not used as mcp token",
    );
    expect(() => unstash(stash, "ssh", { auth: "password", host: "h", port: 22, user: "u", password: stashedMarker(token) })).toThrow(StashRefusal);
    // Refusing it spent nothing: the form it was made for still resolves.
    expect(unstash(stash, "ssh", form(token))).toEqual({ privateKey: expect.stringContaining("OPENSSH PRIVATE KEY") });
});

test("the stash drops its oldest key rather than growing without end", () => {
    const stash = createSecretStash();
    const first = stash.put({ kind: "ssh", field: "privateKey", value: "first" });
    for (let index = 1; index < 32; index += 1) {
        stash.put({ kind: "ssh", field: "privateKey", value: `key-${index}` });
    }
    // Thirty-two held, the first among them.
    expect(stash.peek(first)?.value).toBe("first");
    const newest = stash.put({ kind: "ssh", field: "privateKey", value: "newest" });
    expect(stash.peek(first)).toBeUndefined();
    expect(stash.peek(newest)?.value).toBe("newest");
});

test("never echoed: a generated connection shows its public half, and only the private half is vaulted", () => {
    const pair = generateSshKey("intentic-box");
    const box: Capability = { id: "box", kind: "ssh", config: { auth: "generated", host: "box.example.com", port: 22, user: "root", privateKey: pair.privateKey } };

    expect(sshHandler.echo(box.config, new Map())).toEqual({ host: "box.example.com", port: 22, user: "root", auth: "generated", publicKey: pair.publicKey });
    // What echo leaves out is what the vault takes.
    expect(secretFieldsOf(box, new Map())).toEqual(["privateKey"]);
    expect(sshHandler.secret?.(box.config, new Map())).toBe("privateKey");
});

test("a pasted OpenSSH key shows its public half too; a password shows only the connection", () => {
    const pair = generateSshKey("laptop");
    expect(sshHandler.echo({ auth: "key", host: "h", port: 22, user: "u", privateKey: pair.privateKey }, new Map())).toEqual({
        host: "h",
        port: 22,
        user: "u",
        auth: "key",
        publicKey: pair.publicKey,
    });
    // A PEM key has no public line to read off, so the echo holds only what it always held.
    expect(sshHandler.echo({ auth: "key", host: "h", port: 22, user: "u", privateKey: "-----BEGIN RSA PRIVATE KEY-----\n…" }, new Map())).toEqual({
        host: "h",
        port: 22,
        user: "u",
        auth: "key",
    });
    expect(sshHandler.echo({ auth: "password", host: "h", port: 22, user: "u", password: "pw" }, new Map())).toEqual({
        host: "h",
        port: 22,
        user: "u",
        auth: "password",
    });
});
