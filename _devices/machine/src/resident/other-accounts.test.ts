import { ALLOW_SECOND_AGENT_ENV, otherAccountAgents, otherAgentFix, refuseBesideOtherAccount } from "./other-accounts.js";

/* One agent per computer, whichever account installed it: the process table as inwin's read on 2026-11-24, where
   root's agent and radarsu's ran side by side. */

const INWIN = [
    "  68854  1000 /home/radarsu/.intentic/machine/bin/intentic-machine run --foreground",
    " 120321  1000 /home/radarsu/.intentic/machine/bin/intentic-remoted run --config /home/radarsu/.intentic/machine/remoted.json --parent-stdin",
    " 129731     0 /root/.intentic/machine/bin/intentic-machine run --foreground",
    " 190069     0 /root/.intentic/machine/bin/intentic-remoted run --config /root/.intentic/machine/remoted.json --parent-stdin",
    " 200001  1000 /home/radarsu/.intentic/machine/bin/intentic-machine status",
    " 200002  1000 vim /home/radarsu/.intentic/machine/bin/intentic-machine run",
    "",
].join("\n");

test("each account sees the other's resident agent, and never its own, its remoted, or a one-off command", () => {
    expect(otherAccountAgents(INWIN, 0)).toEqual([{ pid: 68854, uid: 1000, home: "/home/radarsu" }]);
    expect(otherAccountAgents(INWIN, 1000)).toEqual([{ pid: 129731, uid: 0, home: "/root" }]);
    expect(otherAccountAgents(INWIN, 1001)).toHaveLength(2);
});

test("a home with a space in it is read whole, and a table with no agent finds none", () => {
    expect(otherAccountAgents(" 7 501 /Users/Jane Doe/.intentic/machine/bin/intentic-machine run --foreground", 0)).toEqual([
        { pid: 7, uid: 501, home: "/Users/Jane Doe" },
    ]);
    expect(otherAccountAgents("  1 0 /sbin/init\n", 1000)).toEqual([]);
});

test("the way out is said as the account that holds the agent", () => {
    const user = { pid: 1, uid: 1000, home: "/home/radarsu" };
    expect(otherAgentFix(user, "radarsu")).toContain("as radarsu (sudo -iu radarsu)");
    expect(otherAgentFix(user, "radarsu")).toContain("/home/radarsu/.intentic/machine/bin/intentic-machine uninstall");
    expect(otherAgentFix({ pid: 1, uid: 0, home: "/root" }, "root")).toContain("with sudo");
});

test("setup refuses beside another account's agent before it spends the pairing, unless asked to keep both", async () => {
    const found = async (): Promise<readonly { pid: number; uid: number; home: string }[]> => [{ pid: 68854, uid: 1000, home: "/home/radarsu" }];
    await expect(refuseBesideOtherAccount("This device was not connected.", {}, found)).rejects.toThrow(/second computer to your sandboxes/u);
    await expect(refuseBesideOtherAccount("x", { [ALLOW_SECOND_AGENT_ENV]: "1" }, found)).resolves.toBeUndefined();
    await expect(refuseBesideOtherAccount("x", {}, async () => [])).resolves.toBeUndefined();
});
