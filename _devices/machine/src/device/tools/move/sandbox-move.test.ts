import { DeviceScopesSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { icMoveArgs, moveSandbox } from "./sandbox-move.js";

// The argv each move step runs is the whole interface to ic (its sandbox/device_move), so it is pinned here; the
// refusals below all come before anything on the machine is read, so none of them needs an ic or a docker.

const ID = "0123456789abcdef";
const SLUG = "sandbox-850b3ad46a90";
const ALLOWED = DeviceScopesSchema.parse({ sandboxes: "on" });

it("spells each step's ic argv, the plan riding stdin rather than the command line", () => {
    expect(icMoveArgs("move-out", SLUG, { id: ID, stage: "plan" })).toEqual(["sandbox", "move-out", SLUG, "--move", ID, "--plan-only"]);
    expect(icMoveArgs("move-out", SLUG, { id: ID, stage: "send", peer: "a2V5", connect: ["192.168.1.40:41234", "10.0.0.2:41234"], listen: true })).toEqual([
        "sandbox",
        "move-out",
        SLUG,
        "--move",
        ID,
        "--peer",
        "a2V5",
        "--connect",
        "192.168.1.40:41234",
        "--connect",
        "10.0.0.2:41234",
        "--listen",
    ]);
    expect(icMoveArgs("move-prepare", SLUG, { id: ID, plan: { v: 1, slug: SLUG, bytes: 5 }, manager: "compose" })).toEqual([
        "sandbox",
        "move-in",
        SLUG,
        "--move",
        ID,
        "--plan",
        "-",
        "--manager",
        "compose",
    ]);
    expect(icMoveArgs("move-in", SLUG, { id: ID, peer: "a2V5" })).toEqual(["sandbox", "move-in", SLUG, "--move", ID, "--peer", "a2V5"]);
});

it("refuses behind the Manage sandboxes switch", async () => {
    await expect(moveSandbox("move-out", { slug: SLUG, move: { id: ID, stage: "plan" } }, DeviceScopesSchema.parse({}), () => {})).rejects.toThrow(/sandboxes/i);
});

it("refuses a step sent without its move, or missing what that step needs, before ic runs", async () => {
    await expect(moveSandbox("move-in", { slug: SLUG, move: undefined }, ALLOWED, () => {})).rejects.toThrow(
        "move-in is one step of a move between computers, and only the daemon running that move sends it.",
    );
    await expect(moveSandbox("move-in", { slug: SLUG, move: { id: ID } }, ALLOWED, () => {})).rejects.toThrow(
        "Nothing was changed: a move-in carries the sender's public key.",
    );
    await expect(moveSandbox("move-prepare", { slug: SLUG, move: { id: ID } }, ALLOWED, () => {})).rejects.toThrow(
        "Nothing was changed: a move's prepare carries the source's plan.",
    );
    await expect(moveSandbox("move-out", { slug: SLUG, move: { id: ID, stage: "send" } }, ALLOWED, () => {})).rejects.toThrow(
        "Nothing was changed: a move-out is a plan, or a send with the target's public key.",
    );
    await expect(moveSandbox("move-out", { slug: "../x", move: { id: ID, stage: "plan" } }, ALLOWED, () => {})).rejects.toThrow('"../x" is not a sandbox name.');
});
