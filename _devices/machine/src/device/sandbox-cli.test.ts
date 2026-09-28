import { icPassArgs } from "./sandbox-cli.js";

/* `intentic-machine sandbox …` decides nothing: each verb's flags reach ic spelled the way ic spells them. */

test("a verb, its slug and its flags reach ic in ic's own spelling", () => {
    expect(icPassArgs("rollback", "work", { to: "1.4.1", skipPreflight: true })).toEqual(["sandbox", "rollback", "work", "--to", "1.4.1", "--skip-preflight"]);
    expect(icPassArgs("backup", "work", { auto: true, json: true })).toEqual(["sandbox", "backup", "work", "--auto", "--json"]);
    expect(icPassArgs("logs", "work", { tail: "50" })).toEqual(["sandbox", "logs", "work", "--tail", "50"]);
});

// ic picks the sandbox when the machine runs exactly one, so a missing slug is left for it to resolve or refuse.
test("a flag not given, or given off, is not passed, and no slug is not a slug", () => {
    expect(icPassArgs("watch", undefined, { json: undefined })).toEqual(["sandbox", "watch"]);
    expect(icPassArgs("update", undefined, { force: false, channel: undefined })).toEqual(["sandbox", "update"]);
    expect(icPassArgs("list", undefined, { json: true })).toEqual(["sandbox", "list", "--json"]);
});
