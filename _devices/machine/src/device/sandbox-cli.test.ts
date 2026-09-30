import { icPassArgs, keeperStatus, withKeeper } from "./sandbox-cli.js";

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

test("fix passes the recovery panel's code, the ids agreed to and who is asking, spelled as ic spells them", () => {
    expect(icPassArgs("fix", "work", { code: "k3y-9", accept: "wsl,disk", json: true, source: "command" })).toEqual([
        "sandbox",
        "fix",
        "work",
        "--code",
        "k3y-9",
        "--accept",
        "wsl,disk",
        "--json",
        "--source",
        "command",
    ]);
    expect(icPassArgs("fix", undefined, { auto: true, yes: false })).toEqual(["sandbox", "fix", "--auto"]);
});

// On is the key's absence, as every switch of this agent's; off is written down, and nothing else is touched.
test("the keeper's switch writes only an explicit off, and says which way it is", () => {
    const config = { agentUpdates: false, children: ["Ubuntu"] };
    expect(withKeeper(config, false)).toEqual({ agentUpdates: false, children: ["Ubuntu"], sandboxKeeper: false });
    expect(withKeeper({ ...config, sandboxKeeper: false }, true)).toEqual({ agentUpdates: false, children: ["Ubuntu"] });
    expect(keeperStatus(true)).toMatch(/^Keeper: on\. .*`ic sandbox fix --auto`.*`intentic-machine sandbox keeper off`\.$/);
    expect(keeperStatus(false)).toBe(
        "Keeper: off. Nothing brings this machine's sandboxes back by itself; `intentic-machine sandbox fix` does when you run it. Turn it back on with `intentic-machine sandbox keeper on`.",
    );
});
