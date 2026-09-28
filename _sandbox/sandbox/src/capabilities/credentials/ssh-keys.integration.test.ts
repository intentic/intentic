import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { generateSshKey, publicKeyOf } from "./ssh-keys.js";

// The real OpenSSH against the container generateSshKey writes by hand, and publicKeyOf against keys OpenSSH made. The
// ci-base image carries openssh-client (_tools/ci-base/Dockerfile), so CI always runs these.
const keygen = requires(spawnSync("sh", ["-c", "command -v ssh-keygen"]).status === 0, "ssh-keygen on PATH");

const dir = mkdtempSync(join(tmpdir(), "ssh-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!keygen.runs)(keygen.title("ssh-keygen reads a generated key and derives the very line the form showed"), () => {
    const pair = generateSshKey("intentic-box");
    const path = join(dir, "generated");
    // ssh-keygen refuses a private key others can read, as ssh itself does.
    writeFileSync(path, pair.privateKey, { mode: 0o600 });
    const derived = spawnSync("ssh-keygen", ["-y", "-f", path], { encoding: "utf8" });
    expect(derived.status).toBe(0);
    expect(derived.stdout.trim()).toBe(pair.publicKey);
});

test.skipIf(!keygen.runs)(keygen.title("a key ssh-keygen made reads back as its own public line, with a passphrase or without"), () => {
    const cases = [
        { type: "ed25519", passphrase: "" },
        { type: "ecdsa", passphrase: "" },
        { type: "ed25519", passphrase: "correct horse" },
    ];
    for (const { type, passphrase } of cases) {
        const path = join(dir, `${type}-${passphrase === "" ? "open" : "locked"}`);
        expect(spawnSync("ssh-keygen", ["-q", "-t", type, "-N", passphrase, "-C", "ada@laptop", "-f", path]).status).toBe(0);
        const [kind, blob, comment] = readFileSync(`${path}.pub`, "utf8").trim().split(" ");
        // The comment lives in the private section: read only while that is unencrypted, and only for ed25519's layout.
        const expected = passphrase === "" && type === "ed25519" ? `${kind} ${blob} ${comment}` : `${kind} ${blob}`;
        expect(publicKeyOf(readFileSync(path, "utf8")), `${type} ${passphrase === "" ? "open" : "locked"}`).toBe(expected);
    }
});
