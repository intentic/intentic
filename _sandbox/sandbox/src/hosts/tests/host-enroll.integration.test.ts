import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeviceFacts, derivedMachineId, HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { Services } from "../../composition.js";
import type { SyncEnrollmentRow } from "../../peers/desktop-sync.js";
import { createPeerHub } from "../../peers/peer-hub.js";
import { filePeerStore } from "../../peers/peer-store.js";
import { mergeDevices } from "../device-reports.js";
import type { HostGuardDeps } from "../host-guard-deps.js";
import { HOST_PEER, type HostClient, hostConnections, hostPeerRoutes, hostSummaries, identifyMachine } from "../host-peer.js";

// (2026-10-20) A DEVICE PAIRING IS REDEEMED WITH THE MACHINE'S OWN ID, so its enrollment joins the computer's sync row
// from its first write. Before, the route took no body and the record held the card's derived id until the agent
// connected and answered `describe`, and a computer paired that moment was two machine cards until then. Stood up on the
// real store and the real host routes; only the hub is empty (nothing has connected) and the card list is given.

const ROG = "m-rog-0123456789";

const world = () => {
    const hosts = filePeerStore(mkdtempSync(join(tmpdir(), "host-enroll-")), HOST_PEER.store);
    const hostHub = createPeerHub<HostClient, { version: string }, DeviceFacts, DeviceScopes>(HOST_PEER.hub, { warn: () => {} });
    const cards = [{ kind: "device", id: "rog", config: { platform: "windows" } }];
    const services = unstubbed<Services>("services", {
        hosts,
        hostHub,
        logger: unstubbed<Services["logger"]>("logger", { info: () => undefined, warn: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", {
            // SAFETY: a device card is read only for its kind, id and platform here (hostSummaries).
            list: async () => cards as Awaited<ReturnType<Services["capabilities"]["list"]>>,
        }),
    });
    const app = new Hono().post("/enroll", hostPeerRoutes(services, unstubbed<HostGuardDeps>("guards", {})).enroll);
    // Redeems a fresh pairing for `id`, sending `body` as the agent would (nothing at all for an agent older than it).
    const redeem = async (id: string, body?: string): Promise<Response> => {
        const headers = new Headers({ "x-intentic-pair": hosts.mintPairing(id).token });
        const init: RequestInit = { method: "POST", headers };
        if (body !== undefined) {
            headers.set("content-type", "application/json");
            init.body = body;
        }
        return await app.request("/enroll", init);
    };
    const machineIdOf = async (id: string): Promise<string | undefined> => (await hosts.list()).find((entry) => entry.id === id)?.machineId;
    // The Devices screen's rows for this card beside a sync enrollment of the same computer's native install.
    const rows = async () =>
        mergeDevices(
            [{ machine: "radarsu-rog", mode: "sync", machineId: ROG, environment: HOST_NATIVE_ENVIRONMENT } satisfies SyncEnrollmentRow],
            [],
            hostConnections(await hostSummaries(services)).map((host) => ({ host, result: { gap: "offline" } as const })),
        );
    return { hosts, redeem, machineIdOf, rows, services };
};

test("a redeem that says which computer it is records that machine, and the card folds into its sync row at once", async () => {
    const { redeem, machineIdOf, rows } = world();
    const response = await redeem("rog", JSON.stringify({ machineId: ROG, environment: HOST_NATIVE_ENVIRONMENT }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "rog", card: "rog", environment: HOST_NATIVE_ENVIRONMENT, machineId: ROG });
    expect(await machineIdOf("rog")).toBe(ROG);
    // One machine card, before the agent has connected even once.
    const merged = await rows();
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ hostId: "rog", machineId: ROG, sync: { machine: "radarsu-rog" } });
});

// The older agent's fallback: exactly as before, the placeholder until the agent says its id at connect.
test.each([
    ["no body", undefined],
    ["a body that is not JSON", "not json"],
    ["a body that is not an identity", JSON.stringify({ machineId: 42 })],
])("a redeem with %s still enrolls, under the card's placeholder until the agent connects", async (_, body) => {
    const { redeem, machineIdOf, rows } = world();
    const response = await redeem("rog", body);

    expect(response.status).toBe(200);
    expect(await machineIdOf("rog")).toBe(derivedMachineId("rog"));
    expect((await rows()).map((row) => row.hostId)).toEqual([undefined, "rog"]);
});

test("a derived id in the body is no identity, and never stands in for one", async () => {
    const { redeem, machineIdOf } = world();
    await redeem("rog", JSON.stringify({ machineId: derivedMachineId("omen") }));
    expect(await machineIdOf("rog")).toBe(derivedMachineId("rog"));
});

// Its machine id under another install's record would join, and supersede, that install's keys.
test("an identity naming another environment than the pairing's is not written", async () => {
    const { redeem, machineIdOf } = world();
    await redeem("rog", JSON.stringify({ machineId: ROG, environment: "wsl:archlinux" }));
    expect(await machineIdOf("rog")).toBe(derivedMachineId("rog"));
});

// The same dedupe a connect runs (host-dedupe.ts), now at the redeem: the computer re-paired under a new card name
// overwrote its old link, so the old key is one nothing can present again.
test("a redeem that says which computer it is drops the older offline key of that same install at once", async () => {
    const { hosts, redeem } = world();
    await hosts.enroll(hosts.mintPairing("radarsu-rog").token);
    await hosts.amend("radarsu-rog", { machineId: ROG });
    await hosts.enroll(hosts.mintPairing("rog::wsl:archlinux").token);
    await hosts.amend("rog::wsl:archlinux", { machineId: ROG });

    await redeem("rog", JSON.stringify({ machineId: ROG, environment: HOST_NATIVE_ENVIRONMENT }));
    expect((await hosts.list()).map((entry) => entry.id)).toEqual(["rog::wsl:archlinux", "rog"]);
});

test("a connect never replaces a machine id an agent said with a derived one", async () => {
    const { redeem, machineIdOf, services } = world();
    await redeem("rog", JSON.stringify({ machineId: ROG }));
    await identifyMachine(services, "rog", { machineId: derivedMachineId("rog") });
    expect(await machineIdOf("rog")).toBe(ROG);
});
