import { createHmac } from "node:crypto";
import { hostKeyOf, knownHostsFor } from "./ssh.js";

/* Enrolling again replaces what this machine's known_hosts holds for the sandbox's alias, and nothing else in it. */

const ALIAS = "intentic-sync-sandbox-abc";
const PORT = 41_234;
const OLD = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOld";
const NEW = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewNewNewNewNewNewNewNewNewNewNewNewNew";

// What `HashKnownHosts yes` (Debian's and Ubuntu's default) writes for a name.
const hashed = (name: string): string => {
    const salt = Buffer.alloc(20, 7);
    return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(name).digest("base64")}`;
};

test("the alias's entries go, however ssh wrote them, and every other line stays as it was", () => {
    const current = [
        "# kept",
        `${ALIAS} ${OLD}`,
        `[${ALIAS}]:${PORT} ${OLD}`,
        `${hashed(ALIAS)} ${OLD}`,
        `intentic-sync-sandbox-other ${OLD}`,
        `github.com,140.82.121.4 ${OLD}`,
        "",
    ].join("\n");
    expect(knownHostsFor(current, ALIAS, PORT, undefined)).toBe(["# kept", `intentic-sync-sandbox-other ${OLD}`, `github.com,140.82.121.4 ${OLD}`, ""].join("\n"));
});

// With the key the enrollment handed over, the first connection has nothing left to trust on first use.
test("a key the enrollment carried is pinned in the entries' place", () => {
    expect(knownHostsFor(`${ALIAS} ${OLD}\n`, ALIAS, PORT, NEW)).toBe(`${ALIAS} ${NEW}\n`);
    expect(knownHostsFor("", ALIAS, PORT, NEW)).toBe(`${ALIAS} ${NEW}\n`);
});

test("an alias the file never named leaves it byte for byte", () => {
    const current = `other ${OLD}\n`;
    expect(knownHostsFor(current, ALIAS, PORT, undefined)).toBe(current);
    expect(knownHostsFor("", ALIAS, PORT, undefined)).toBe("");
});

// Whatever arrives from the enrollment is pinned only if it IS a public key line: anything else would be written into
// known_hosts verbatim.
test("only a public key line is taken from an enrollment", () => {
    expect(hostKeyOf(` ${NEW} `)).toBe(NEW);
    expect(hostKeyOf(`${NEW}\nevil.example ${OLD}`)).toBeUndefined();
    expect(hostKeyOf("ssh-ed25519")).toBeUndefined();
    expect(hostKeyOf(undefined)).toBeUndefined();
});
