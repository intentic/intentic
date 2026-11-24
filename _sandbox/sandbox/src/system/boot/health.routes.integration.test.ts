import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialDigest, loopbackProof, proofKeyOf } from "@intentic/sandbox-contract/protocol/doors/loopback-proof";
import { DaemonHealthSchema } from "@intentic/sandbox-contract/schemas/system";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { LISTENER_HEADER, LOOPBACK_LISTENER } from "../../auth/proofs/listener.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { answerChallenge } from "../../peers/enrollment.js";
import { enrollSyncKey } from "../../peers/desktop-sync.js";
import { healthRawRoutes } from "./health.routes.js";

// A machine agent's loopback challenge on /health: answered only on the loopback port, only for a credential this daemon
// issued (a host link's, or a sync pairing's on a real temp /history), and keyed so that nothing else could answer it.
// HOME is a temp dir, since a sync enrollment writes authorized_keys there.

process.env["HOME"] = mkdtempSync(join(tmpdir(), "health-proof-"));
const historyRoot = mkdtempSync(join(tmpdir(), "health-proof-history-"));
const CONNECT = "connect-token";
const SANDBOX = sandboxIdFromToken(CONNECT) ?? "";
const LINK = "ihost_link-token";
const CHALLENGE = "a".repeat(64);

const app = (): Hono => {
    const hono = new Hono();
    const routes = healthRawRoutes({
        config: { ...testConfig, connectToken: CONNECT, historyRoot },
        boot: unstubbed<Services["boot"]>("boot", { progress: () => ({ ready: true, startedAt: 0, steps: [] }) }),
        announcer: unstubbed<Services["announcer"]>("announcer", { status: () => ({ state: "off" }) }),
        reach: unstubbed<Services["reach"]>("reach", { status: () => ({ state: "off" }) }),
        auth: undefined,
        // The host door's own challenge answer over one enrolled link, as filePeerStore's does over its manifest.
        hosts: unstubbed<Services["hosts"]>("hosts", { prove: async (key, sandboxId, challenge) => answerChallenge([credentialDigest(LINK)], key, sandboxId, challenge) }),
    });
    hono.get("/health", routes["GET /health"]);
    return hono;
};

const proofOf = async (token: string, { loopback = true, challenge = CHALLENGE } = {}): Promise<string | undefined> => {
    const query = `?proof=${challenge}&proofKey=${proofKeyOf(credentialDigest(token))}`;
    const response = await app().request(`/health${query}`, { headers: loopback ? { [LISTENER_HEADER]: LOOPBACK_LISTENER } : {} });
    return DaemonHealthSchema.parse(await response.json()).proof;
};

test("a host link's challenge on the loopback port is answered with the proof only its digest can make", async () => {
    expect(await proofOf(LINK)).toBe(loopbackProof(credentialDigest(LINK), SANDBOX, CHALLENGE));
});

test("a sync pairing's challenge is answered from the sync enrollments", async () => {
    const enrolled = await enrollSyncKey({ historyRoot, key: "ssh-ed25519 AAAAproof proof", mode: "mirror", takeover: false });
    const token = "syncToken" in enrolled ? enrolled.syncToken : "";
    expect(await proofOf(token)).toBe(loopbackProof(credentialDigest(token), SANDBOX, CHALLENGE));
});

// Through the tunnel a stranger holding the loopback port could ask for the proof and hand it back to the agent.
test("nothing is proven off the loopback port, for a credential nobody holds, or for a challenge of the wrong shape", async () => {
    expect(await proofOf(LINK, { loopback: false })).toBeUndefined();
    expect(await proofOf("ihost_someone-else")).toBeUndefined();
    expect(await proofOf(LINK, { challenge: "short" })).toBeUndefined();
});
