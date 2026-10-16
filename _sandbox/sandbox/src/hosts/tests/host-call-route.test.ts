import { HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { hostCallRoute, partlyConnectedRefusal } from "../host-call-route.js";

// ONE CARD, ONE COMPUTER, A SOCKET PER SIDE (2026-10-15). rog's Windows agent went away while its WSL agent stayed
// connected, and every call to rog was refused for two days, `in: "wsl:archlinux"` included. A call naming a side that
// is up goes to that side's own agent; anything else is told which sides are up and how to reach them.

const RECORDS = [
    { id: "rog", card: "rog", environment: HOST_NATIVE_ENVIRONMENT, machineId: "card:rog" },
    { id: "rog::wsl:archlinux", card: "rog", environment: "wsl:archlinux", machineId: "card:rog" },
    { id: "rog::wsl:ubuntu", card: "rog", environment: "wsl:ubuntu", machineId: "card:rog" },
    { id: "omen::wsl:archlinux", card: "omen", environment: "wsl:archlinux", machineId: "card:omen" },
];

const routeOver = (online: readonly string[]) =>
    hostCallRoute({
        hosts: unstubbed<Services["hosts"]>("hosts", { list: async () => RECORDS }),
        hostHub: unstubbed<Services["hostHub"]>("hostHub", { online: (id: string) => online.includes(id) }),
    });

const call = (args: Record<string, unknown>) => ({
    jsonrpc: "2.0" as const,
    id: 3,
    method: "tools/call",
    params: { name: "run_command", arguments: args },
});

test("a call naming an awake distro goes to that distro's own agent, without the crossing it no longer needs", async () => {
    const route = routeOver(["rog::wsl:archlinux"]);
    expect(await route("rog", call({ command: "uname -a", in: "wsl:archlinux", timeoutMs: 5000 }))).toEqual({
        id: "rog::wsl:archlinux",
        message: call({ command: "uname -a", timeoutMs: 5000 }),
    });
    // WSL's names are case-blind, so a model's spelling is too.
    expect(await route("rog", call({ command: "ls", in: "wsl:ArchLinux" }))).toMatchObject({ id: "rog::wsl:archlinux" });
});

// The minimal change: while the Windows side answers, a call crosses through it as it always did.
test("nothing is rerouted while the Windows side holds its socket", async () => {
    const route = routeOver(["rog", "rog::wsl:archlinux"]);
    expect(await route("rog", call({ command: "ls", in: "wsl:archlinux" }))).toBeUndefined();
});

test("a call naming no side, or one that is down, is told which sides are up and how to reach them", async () => {
    const route = routeOver(["rog::wsl:archlinux"]);
    const bare = await route("rog", call({ command: "dir" }));
    expect(bare).toEqual({ refusal: partlyConnectedRefusal("rog", ["wsl:archlinux"], undefined) });
    const asleep = await route("rog", call({ command: "ls", in: "wsl:ubuntu" }));
    expect(asleep).toEqual({ refusal: partlyConnectedRefusal("rog", ["wsl:archlinux"], "wsl:ubuntu") });
    // A tool with no crossing at all is refused the same way: only the Windows side serves it.
    expect(await route("rog", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "screenshot", arguments: {} } })).toHaveProperty(
        "refusal",
    );
});

// Another card's distro is another computer, however its environment is spelled.
test("only the card's own sides count, and with none of them up the door's own offline answer stands", async () => {
    expect(await routeOver(["omen::wsl:archlinux"])("rog", call({ command: "ls", in: "wsl:archlinux" }))).toBeUndefined();
    expect(await routeOver([])("rog", call({ command: "ls", in: "wsl:archlinux" }))).toBeUndefined();
});

// The handshake and the tool list are answered for the card whatever its sides are doing.
test("only a tool call is routed", async () => {
    const route = routeOver(["rog::wsl:archlinux"]);
    expect(await route("rog", { jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeUndefined();
    expect(await route("rog", { jsonrpc: "2.0", id: 1, method: "initialize" })).toBeUndefined();
});

test("the refusal names every side that is up, and the way into each", () => {
    expect(partlyConnectedRefusal("rog", ["wsl:archlinux"], undefined)).toBe(
        `"rog" (its Windows side) is not connected right now: its agent there is not running or cannot reach this sandbox. ` +
            `Its WSL side archlinux is: pass in: "wsl:archlinux" to run_command to run there. ` +
            `Every other tool reaches the Windows side only, so it waits until that side is back.`,
    );
    expect(partlyConnectedRefusal("rog", ["wsl:archlinux", "wsl:ubuntu"], "wsl:debian")).toBe(
        `Nothing on "rog" answers to in: "wsl:debian" right now, and its Windows side is not connected either: its agent there is not running or cannot reach this sandbox. ` +
            `Its WSL sides archlinux and ubuntu are: pass in: "wsl:archlinux" or in: "wsl:ubuntu" to run_command to run in one. ` +
            `Every other tool reaches the Windows side only, so it waits until that side is back.`,
    );
});
