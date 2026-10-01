import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { CLEAR_STATE_PLAN, type FakeFly, installFakeFly } from "./fly-fake.js";

/* A FIXTURE WITH RULES IN IT NEEDS ITS OWN TEST. This one is not a stub returning canned JSON: it refuses a fork
 * smaller than its source, refuses a restore from a snapshot that has not finished, and remembers which machine is
 * running. Every suite that trusts those answers is only as right as this file, so the rules are pinned here rather
 * than discovered in whichever suite happens to depend on one. */

const BASE = "https://api.machines.dev/v1";

const install = (faults: Parameters<typeof installFakeFly>[1] = {}): FakeFly => installFakeFly((name, value) => stubGlobal(name, value), faults);

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${BASE}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

// The snapshot a POST …/snapshots scheduled: Fly answers the backup job, and its `graph_id` is the snapshot's listed id.
// SAFETY: the fake answers that route with snapshotRoute's envelope or with a refusal, and a refusal carries no `Msg`.
const scheduledId = (answer: Record<string, unknown>): string => String((answer["Msg"] as { backup?: { graph_id?: string } } | undefined)?.backup?.graph_id ?? "");

afterEach(() => {
    unstubAllGlobals();
});

describe("what the fake answers", () => {
    /* THE ANSWER FLY GIVES, which is not the snapshot: the client that read it as one passed every suite while this
     * fake answered the listed shape, and failed every real migration (2026-10-01). */
    it("answers a snapshot request with the backup job Fly scheduled, naming the snapshot it will list", async () => {
        const fly = install();
        const { volume } = fly.seedSandbox("app");
        const taken = await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        expect(taken.status).toBe(200);
        expect(Object.keys(taken.json)).toEqual(["Msg"]);
        const snapshotId = scheduledId(taken.json);
        const listed: unknown = await (await fetch(`${BASE}/apps/app/volumes/${volume.id}/snapshots`)).json();
        expect(listed).toEqual([{ id: snapshotId, status: "created", created_at: fly.snapshots.get(snapshotId)?.createdAt, size: volume.usedBytes }]);
    });

    it("lists a snapshot it is still taking under Fly's zero time and no size", async () => {
        const fly = install({ faults: { snapshotNeverFinishes: true } });
        const { volume } = fly.seedSandbox("app");
        const snapshotId = scheduledId((await call("POST", `/apps/app/volumes/${volume.id}/snapshots`)).json);
        const listed: unknown = await (await fetch(`${BASE}/apps/app/volumes/${volume.id}/snapshots`)).json();
        expect(listed).toEqual([{ id: snapshotId, status: "running", created_at: "0001-01-01T00:00:00Z", size: 0 }]);
    });
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
        const snapshotId = scheduledId(taken.json);
        expect(fly.snapshots.get(snapshotId)?.status).toBe("running");
        const restore = await call("POST", "/apps/app/volumes", { region: "arn", size_gb: 10, snapshot_id: snapshotId });
        expect(restore.status).toBe(422);
        expect(restore.json["error"]).toBe(`snapshot ${snapshotId} is not ready to restore from`);
    });

    /* ONE SNAPSHOT OF A VOLUME AT A TIME, as Fly takes them: the next is refused, in Fly's words, until the one it is
     * taking reads `created`. A run that asked for one and then failed leaves exactly this for the run after it. */
    it("refuses a second snapshot of a volume while the first is unfinished, and takes one once it is", async () => {
        const fly = install({ faults: { snapshotNeverFinishes: true } });
        const { volume } = fly.seedSandbox("app");
        const first = scheduledId((await call("POST", `/apps/app/volumes/${volume.id}/snapshots`)).json);
        const refused = await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        expect(refused.status).toBe(412);
        expect(refused.json["error"]).toBe(`failed_precondition: snapshot is already scheduled at ${fly.snapshots.get(first)?.createdAt ?? ""}`);

        const held = fly.snapshots.get(first);
        if (held === undefined) {
            throw new Error(`the fake holds no snapshot ${first}`);
        }
        held.status = "created";
        const next = await call("POST", `/apps/app/volumes/${volume.id}/snapshots`);
        expect(next.status).toBe(200);
        expect(scheduledId(next.json)).not.toBe(first);
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

describe("running a command in a machine", () => {
    // The state gate's probe is only as right as this: Fly runs a command only in a machine that is running.
    it("runs one only in a started machine, answering the planner's clear plan unless told otherwise", async () => {
        const fly = install();
        const { machine } = fly.seedSandbox("app");
        const ran = await call("POST", `/apps/app/machines/${machine.id}/exec`, { command: ["node", "state-plan.js"], timeout: 60 });
        expect(ran.status).toBe(200);
        expect(JSON.parse(String(ran.json["stdout"]))).toEqual(CLEAR_STATE_PLAN);
        fly.commands.answer = () => ({ exit_code: 1, stdout: "", stderr: "no" });
        expect((await call("POST", `/apps/app/machines/${machine.id}/exec`, { command: [] })).json).toEqual({ exit_code: 1, stdout: "", stderr: "no" });
        await call("POST", `/apps/app/machines/${machine.id}/stop`);
        expect((await call("POST", `/apps/app/machines/${machine.id}/exec`, { command: [] })).status).toBe(412);
    });

    it("leaves a machine stopped on a start while its config names an image that will not boot", async () => {
        const fly = install({ faults: { imageWontStart: "bad" } });
        const { machine } = fly.seedSandbox("app");
        await call("POST", `/apps/app/machines/${machine.id}`, { config: { image: "bad" } });
        await call("POST", `/apps/app/machines/${machine.id}/start`);
        expect(fly.machines.get(machine.id)?.state).toBe("stopped");
        await call("POST", `/apps/app/machines/${machine.id}`, { config: { image: "good" } });
        await call("POST", `/apps/app/machines/${machine.id}/start`);
        expect(fly.machines.get(machine.id)?.state).toBe("started");
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
        const elsewhere = jest.fn(async () => new Response(`{"from":"elsewhere"}`));
        installFakeFly((name, value) => stubGlobal(name, value), { passThrough: elsewhere });
        const answered = await fetch("https://api.stripe.com/v1/subscriptions/sub_1");
        expect(await answered.json()).toEqual({ from: "elsewhere" });
        expect(elsewhere).toHaveBeenCalledTimes(1);
    });
});
