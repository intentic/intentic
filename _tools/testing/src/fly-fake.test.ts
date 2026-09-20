import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeFly, installFakeFly } from "./fly-fake.js";

/* A FIXTURE WITH RULES IN IT NEEDS ITS OWN TEST. This one is not a stub returning canned JSON: it refuses a fork
 * smaller than its source, refuses a restore from a snapshot that has not finished, and remembers which machine is
 * running. Every suite that trusts those answers is only as right as this file, so the rules are pinned here rather
 * than discovered in whichever suite happens to depend on one. */

const BASE = "https://api.machines.dev/v1";

const install = (faults: Parameters<typeof installFakeFly>[1] = {}): FakeFly =>
    installFakeFly((name, value) => vi.stubGlobal(name, value), faults);

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${BASE}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("what the fake refuses", () => {
    it("will not fork or restore into a volume smaller than the one it came from", async () => {
        const fly = install();
        const { volume } = fly.seedSandbox("app", { sizeGb: 25 });
        const smaller = await call("POST", "/apps/app/volumes", { region: "iad", size_gb: 10, source_volume_id: volume.id });
        expect(smaller.status).toBe(422);
        expect(smaller.json["error"]).toContain("greater than or equal");
        // Equal or larger is taken, which is the rule a downgrade's "keep the disk" depends on.
        expect((await call("POST", "/apps/app/volumes", { region: "iad", size_gb: 25, source_volume_id: volume.id })).status).toBe(200);
    });

    it("will not restore from a snapshot that has not finished", async () => {
        const fly = install({ faults: { snapshotNeverFinishes: true } });
        const { volume } = fly.seedSandbox("app");
        const taken = await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        expect(taken.json["status"]).toBe("running");
        const restore = await call("POST", "/apps/app/volumes", { region: "arn", size_gb: 10, snapshot_id: taken.json["id"] });
        expect(restore.status).toBe(422);
        expect(restore.json["error"]).toContain("not ready to restore");
    });

    // A fake that answers everything hides the call you got wrong, which is the whole reason this one does not.
    it("answers a path nobody modelled with a 404 that names it", async () => {
        install();
        const unmounted = await call("POST", "/apps/app/machines/m1/lease");
        expect(unmounted.status).toBe(404);
        expect(unmounted.json["error"]).toBe("fake fly: nothing is mounted at POST /v1/apps/app/machines/m1/lease");
    });

    it("refuses a create in the provider's own out-of-capacity words when asked to", async () => {
        const fly = install({ faults: { atCapacity: true } });
        fly.apps.add("app");
        const refused = await call("POST", "/apps/app/machines", { name: "m", region: "iad", config: {} });
        expect(refused.status).toBe(422);
        // The client reads a capacity refusal off Fly's WORDING, since Fly publishes no code for it.
        expect(refused.json["error"]).toContain("reached the limit");
    });
});

describe("what the fake remembers", () => {
    it("carries the source's written bytes into a fork, which is how a move proves the data went", async () => {
        const fly = install();
        const { volume } = fly.seedSandbox("app", { sizeGb: 10, usedBytes: 3 * 1024 ** 3 });
        const forked = await call("POST", "/apps/app/volumes", { region: "iad", size_gb: 10, source_volume_id: volume.id });
        const copy = fly.volumes.get(String(forked.json["id"]));
        expect(copy?.usedBytes).toBe(volume.usedBytes);
        // Read back through the API the client uses: blocks minus free, at 4 KiB a block.
        const read = await call("GET", `/apps/app/volumes/${copy?.id ?? ""}`);
        expect((Number(read.json["blocks"]) - Number(read.json["blocks_avail"])) * 4096).toBe(3 * 1024 ** 3);
    });

    it("grows a volume and leaves what is on it alone", async () => {
        const fly = install();
        const { volume } = fly.seedSandbox("app", { sizeGb: 10, usedBytes: 1024 ** 3 });
        const extended = await call("PUT", `/apps/app/volumes/${volume.id}/extend`, { size_gb: 25 });
        expect(extended.json["needs_restart"]).toBe(true);
        expect(fly.volumes.get(volume.id)).toMatchObject({ sizeGb: 25, usedBytes: 1024 ** 3 });
        // Shrinking is the one thing Fly will not do, and the whole reason a downgrade keeps its disk.
        expect((await call("PUT", `/apps/app/volumes/${volume.id}/extend`, { size_gb: 5 })).status).toBe(422);
    });

    it("tracks a machine's power, so a stopped one does not answer started", async () => {
        const fly = install();
        const { machine } = fly.seedSandbox("app");
        await call("POST", `/apps/app/machines/${machine.id}/stop`);
        expect((await call("GET", `/apps/app/machines/${machine.id}`)).json["state"]).toBe("stopped");
        await call("POST", `/apps/app/machines/${machine.id}/start`);
        expect((await call("GET", `/apps/app/machines/${machine.id}`)).json["state"]).toBe("started");
    });

    it("leaves a machine stopped when the host will not take it, however often it is started", async () => {
        const fly = install({ faults: { machineWontStart: true } });
        const { machine } = fly.seedSandbox("app");
        await call("POST", `/apps/app/machines/${machine.id}/start`);
        await call("POST", `/apps/app/machines/${machine.id}/start`);
        expect((await call("GET", `/apps/app/machines/${machine.id}`)).json["state"]).toBe("stopped");
    });

    it("takes an app's machines and volumes down with it", async () => {
        const fly = install();
        fly.seedSandbox("app");
        fly.seedSandbox("other");
        await call("DELETE", "/apps/app");
        expect([...fly.machines.values()].map((machine) => machine.app)).toEqual(["other"]);
        expect([...fly.volumes.values()].map((volume) => volume.app)).toEqual(["other"]);
    });
});

describe("what the fake records", () => {
    it("matches the END of a path, so a snapshot is never read as a volume create", async () => {
        const fly = install();
        const { volume } = fly.seedSandbox("app");
        await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        expect(fly.called("POST", "/volumes")).toEqual([]);
        expect(fly.called("POST", "/snapshots")).toHaveLength(1);
    });

    it("keeps the order, which is what an ordering assertion is made of", async () => {
        const fly = install();
        const { machine, volume } = fly.seedSandbox("app");
        await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        await call("POST", `/apps/app/machines/${machine.id}/stop`);
        expect(fly.indexOf("POST", "/snapshots")).toBeLessThan(fly.indexOf("POST", "/stop"));
        expect(fly.indexOf("DELETE", "/nothing")).toBe(-1);
    });

    it("lets a fault be switched on between two calls", async () => {
        const fly = install();
        fly.apps.add("app");
        expect((await call("POST", "/apps/app/machines", { name: "m", region: "iad", config: {} })).status).toBe(200);
        fly.fail({ atCapacity: true });
        expect((await call("POST", "/apps/app/machines", { name: "m", region: "iad", config: {} })).status).toBe(422);
    });

    it("passes anything that is not Fly through to the real fetch", async () => {
        const elsewhere = vi.fn(async () => new Response(`{"from":"elsewhere"}`));
        installFakeFly((name, value) => vi.stubGlobal(name, value), { passThrough: elsewhere as unknown as typeof fetch });
        const answered = await fetch("https://api.stripe.com/v1/subscriptions/sub_1");
        expect(await answered.json()).toEqual({ from: "elsewhere" });
        expect(elsewhere).toHaveBeenCalledTimes(1);
    });
});
