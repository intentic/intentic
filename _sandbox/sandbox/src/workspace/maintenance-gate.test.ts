import { expect, test } from "vitest";
import { createWorkspaceMaintenanceGate } from "./maintenance-gate.js";

test("maintenance waits for existing turns and prevents a later turn entering the gap", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const first = await gate.enterTurn();
    const order: string[] = [];
    const maintenance = gate.runMaintenance(async () => {
        order.push("maintenance-start");
        await Promise.resolve();
        order.push("maintenance-end");
    });
    const laterTurn = gate.enterTurn().then((lease) => {
        order.push("later-turn");
        lease.release();
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    first.release();
    await maintenance;
    await laterTurn;
    expect(order).toEqual(["maintenance-start", "maintenance-end", "later-turn"]);
});

test("ordinary turns remain concurrent when no maintenance is waiting", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const first = await gate.enterTurn();
    const second = await gate.enterTurn();
    first.release();
    second.release();
});

test("a parked turn lets maintenance run, and takes the workspace back before resuming", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const lease = await gate.enterTurn();
    const order: string[] = [];
    let wake: (() => void) | undefined;

    // The park is the whole of what this turn is doing — it holds the workspace either side of it.
    const parked = lease
        .park(async () => {
            order.push("park-start");
            await new Promise<void>((resolve) => (wake = resolve));
            order.push("park-end");
        })
        .then(() => order.push("turn-resumed"));

    await Promise.resolve();
    const maintenance = gate.runMaintenance(async () => {
        order.push("maintenance");
    });
    // Without the park this could not start: the turn has not ended and would still be holding a reader slot.
    await maintenance;
    expect(order).toEqual(["park-start", "maintenance"]);

    wake?.();
    await parked;
    expect(order).toEqual(["park-start", "maintenance", "park-end", "turn-resumed"]);

    // The slot really came back: maintenance queued now has to wait for the turn to end.
    let ran = false;
    const after = gate.runMaintenance(async () => {
        ran = true;
    });
    await Promise.resolve();
    expect(ran).toBe(false);
    lease.release();
    await after;
    expect(ran).toBe(true);
});

test("a turn resuming from a park queues behind maintenance that is already running", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const lease = await gate.enterTurn();
    let releaseMaintenance: (() => void) | undefined;
    let resumed = false;

    const parked = lease.park(() => Promise.resolve()).then(() => (resumed = true));
    // Slip maintenance in while the turn is parked: the resume must wait for it rather than walking into a
    // tree that is being rewritten.
    const maintenance = gate.runMaintenance(() => new Promise<void>((resolve) => (releaseMaintenance = resolve)));

    await Promise.resolve();
    await Promise.resolve();
    expect(resumed).toBe(false);
    releaseMaintenance?.();
    await maintenance;
    await parked;
    expect(resumed).toBe(true);
    lease.release();
});

test("a turn stopped while parked drops nothing: its release cannot free another turn's slot", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const controller = new AbortController();
    const lease = await gate.enterTurn(controller.signal);
    const other = await gate.enterTurn();

    await lease.park(async () => {
        controller.abort();
    });
    // The parked turn came back empty-handed, so its release is a no-op — `other` is still holding the
    // workspace and maintenance must not start.
    lease.release();
    let ran = false;
    const maintenance = gate.runMaintenance(async () => {
        ran = true;
    });
    await Promise.resolve();
    expect(ran).toBe(false);

    other.release();
    await maintenance;
    expect(ran).toBe(true);
});

test("a turn aborted while maintenance is running never enters afterwards", async () => {
    const gate = createWorkspaceMaintenanceGate();
    let releaseMaintenance: (() => void) | undefined;
    const maintenance = gate.runMaintenance(() => new Promise<void>((resolve) => (releaseMaintenance = resolve)));
    await Promise.resolve();
    const controller = new AbortController();
    const turn = gate.enterTurn(controller.signal);
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    releaseMaintenance?.();
    await maintenance;
});
