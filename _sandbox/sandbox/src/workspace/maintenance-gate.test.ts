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
