import type { DeviceSandboxFlow, DeviceSandboxMove } from "@intentic/sandbox-contract/schemas/devices";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { assertScope } from "../../policy.js";
import { fleet, findIn, icFlow } from "../sandboxes.js";

/* CARRYING A SANDBOX TO ANOTHER OF THE OWNER'S COMPUTERS (2026-11-11, `sandboxes move`). The daemon of a sandbox that
reaches both machines runs three ops here, each one `ic` run (ic's sandbox/device_move): `move-out` on the computer that
runs the sandbox (its read-only plan, then the send), `move-prepare` on the one it goes to (disk, image and overlay while
the sandbox still runs, then the receive, all one process holding its ephemeral key), and `move-in` there to hand that
waiting process the sender's public key. The keys, the archive and the at-rest key stay inside the two ic processes and
their encrypted stream: this agent only starts them and narrates what they print. Behind the "Manage sandboxes" switch
like every op that changes a sandbox. The two long runs are marked as moving a container, so this agent never restarts
under them, and they run in their own process group (runStreamed), so an agent that does stop leaves them finishing. */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The ic argv each move op runs, the one place they are spelled. Pure, so the argv is asserted without an ic.
export const icMoveArgs = (op: "move-prepare" | "move-out" | "move-in", slug: string, move: DeviceSandboxMove): string[] => {
    switch (op) {
        case "move-out":
            return move.stage === "plan"
                ? ["sandbox", "move-out", slug, "--move", move.id, "--plan-only"]
                : [
                      "sandbox",
                      "move-out",
                      slug,
                      "--move",
                      move.id,
                      "--peer",
                      move.peer ?? "",
                      ...(move.connect ?? []).flatMap((address) => ["--connect", address]),
                      ...(move.listen === true ? ["--listen"] : []),
                  ];
        case "move-prepare":
            return ["sandbox", "move-in", slug, "--move", move.id, "--plan", "-", ...(move.manager === undefined ? [] : ["--manager", move.manager])];
        case "move-in":
            return ["sandbox", "move-in", slug, "--move", move.id, "--peer", move.peer ?? ""];
    }
};

// What each op needs of its `move` before ic runs: refused here with the field named, never handed to ic half-filled.
const missing = (op: "move-prepare" | "move-out" | "move-in", move: DeviceSandboxMove): string | undefined => {
    if (op === "move-prepare") {
        return move.plan === undefined ? "a move's prepare carries the source's plan" : undefined;
    }
    if (op === "move-in") {
        return move.peer === undefined ? "a move-in carries the sender's public key" : undefined;
    }
    if (move.stage === "plan") {
        return undefined;
    }
    return move.stage !== "send" || move.peer === undefined ? "a move-out is a plan, or a send with the target's public key" : undefined;
};

export const moveSandbox = async (
    op: "move-prepare" | "move-out" | "move-in",
    { slug, move }: Pick<DeviceSandboxFlow, "slug" | "move">,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    if (move === undefined) {
        throw new Error(`${op} is one step of a move between computers, and only the daemon running that move sends it.`);
    }
    const lacking = missing(op, move);
    if (lacking !== undefined) {
        throw new Error(`Nothing was changed: ${lacking}.`);
    }
    if (!SLUG.test(slug)) {
        throw new Error(`"${slug}" is not a sandbox name.`);
    }
    const here = await fleet();
    if (op === "move-out") {
        findIn(here, slug);
    } else if (op === "move-prepare" && here.some((box) => box.slug === slug)) {
        // The receive makes the container under this very name: one already here is a sandbox it would collide with,
        // refused before the source is touched rather than after its copy.
        throw new Error(`A sandbox "${slug}" is already on this device, so it cannot be moved here. Nothing was changed.`);
    }
    // Only the send and the receive move a container; the plan and the key hand-off read and write nothing of it.
    const moves = op === "move-prepare" || (op === "move-out" && move.stage === "send");
    // The plan rides ic's stdin, never its argv: it is long, and a command line is readable by anyone on the machine.
    const input = op === "move-prepare" ? JSON.stringify(move.plan) : undefined;
    const run = await icFlow(slug, icMoveArgs(op, slug, move), onLine, { moves, input });
    if (run.code !== 0) {
        throw new Error(`That ${op} failed on this device.\n\n${run.output}`);
    }
    return op === "move-out" && move.stage === "plan" ? `Planned the move of ${slug}.` : `${op} of ${slug} finished on this device.`;
};
