import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { filePeerStore } from "../../peers/peer-store.js";
import { RUNNER_PEER } from "../runner-peer.js";
import { enrolledRunnersAt, runnerUplinks } from "./runner-uplinks.js";

const reported = (uplinks: readonly (readonly [string, boolean])[]) => ({
    kind: "runnerUplinks" as const,
    uplinks: uplinks.map(([runner, connected]) => ({ runner, connected })),
});

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runner-uplinks-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

// A runner enrolled the way the parent enrolls one: a pairing redeemed for its durable token.
const enroll = async (id: string): Promise<string> => {
    const store = filePeerStore(root, RUNNER_PEER.store);
    const { token } = store.mintPairing(id);
    const enrolled = await store.enroll(token);
    return enrolled!.token;
};

const failOnError = (error: Error): void => {
    throw error;
};

test("nothing is sent to a netd that has not reported runner uplinks: an older one closes the link on the frame", async () => {
    await enroll("r1");
    const told: FromNode[] = [];
    const uplinks = runnerUplinks((message) => told.push(message), enrolledRunnersAt(root), failOnError);
    await uplinks.reconcile();
    expect([uplinks.supported(), told]).toEqual([false, []]);
    uplinks.stop();
});

test("each enrolled runner is registered by its token's digest once netd reports, and a revoked one withdrawn", async () => {
    const token = await enroll("r1");
    const told: FromNode[] = [];
    const uplinks = runnerUplinks((message) => told.push(message), enrolledRunnersAt(root), failOnError);
    uplinks.heard(reported([]));
    await uplinks.reconcile();
    // The digest netd checks a dial's token against (uplinks.rs `digest_of`): the token's own SHA-256.
    expect(told).toEqual([{ kind: "runnerUplink", runner: "r1", tokenSha256: sha256Hex(token) }]);
    // Registered: the same digest is not sent again on netd's report or a beat.
    uplinks.heard(reported([["r1", true]]));
    await uplinks.reconcile();
    expect(told).toHaveLength(1);
    expect(uplinks.connected("r1")).toBe(true);
    // Revoked on the parent: withdrawn from netd, which closes its uplink.
    await filePeerStore(root, RUNNER_PEER.store).revoke("r1");
    await uplinks.reconcile();
    expect(told.at(-1)).toEqual({ kind: "runnerWithdraw", runner: "r1" });
    uplinks.stop();
});

test("a registration an earlier daemon left for a runner no longer enrolled is withdrawn, and a re-paired one re-registered", async () => {
    const told: FromNode[] = [];
    const uplinks = runnerUplinks((message) => told.push(message), enrolledRunnersAt(root), failOnError);
    // netd still holds `gone` from before this daemon started.
    uplinks.heard(reported([["gone", false]]));
    await uplinks.reconcile();
    expect(told).toEqual([{ kind: "runnerWithdraw", runner: "gone" }]);
    const first = await enroll("r1");
    uplinks.heard(reported([]));
    await uplinks.reconcile();
    const second = await enroll("r1");
    await uplinks.reconcile();
    expect(told.slice(1)).toEqual([
        { kind: "runnerUplink", runner: "r1", tokenSha256: sha256Hex(first) },
        { kind: "runnerUplink", runner: "r1", tokenSha256: sha256Hex(second) },
    ]);
    uplinks.stop();
});

test("an unreadable enrollment manifest withdraws nothing", async () => {
    const told: FromNode[] = [];
    const uplinks = runnerUplinks((message) => told.push(message), async () => undefined, failOnError);
    uplinks.heard(reported([["r1", true]]));
    await uplinks.reconcile();
    expect(told).toEqual([]);
    uplinks.stop();
});
