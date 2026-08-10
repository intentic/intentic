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

test("a check starts only into full quiet — behind maintenance AND the turns that were waiting on it", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const first = await gate.enterTurn();
    const order: string[] = [];
    const maintenance = gate.runMaintenance(async () => {
        order.push("maintenance");
    });
    const laterTurn = gate.enterTurn().then((lease) => {
        order.push("later-turn");
        lease.release();
    });
    const check = gate.runChecks(async () => {
        order.push("check");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first.release();
    await maintenance;
    await laterTurn;
    await check;
    expect(order).toEqual(["maintenance", "later-turn", "check"]);
});

test("a turn arriving while a check runs walks straight in — checks never hold turns out", async () => {
    const gate = createWorkspaceMaintenanceGate();
    let releaseCheck: (() => void) | undefined;
    const check = gate.runChecks(() => new Promise<void>((resolve) => (releaseCheck = resolve)));
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseCheck).toBeDefined();
    // The check holds only a reader slot, so this resolves on the fast path rather than queueing behind it.
    const turn = await gate.enterTurn();
    turn.release();
    releaseCheck?.();
    await check;
});

test("an install queued during a check waits for the check's reader slot to come back", async () => {
    const gate = createWorkspaceMaintenanceGate();
    const order: string[] = [];
    let releaseCheck: (() => void) | undefined;
    const check = gate.runChecks(() => new Promise<void>((resolve) => (releaseCheck = resolve)).then(() => order.push("check-end")));
    await Promise.resolve();
    await Promise.resolve();
    const maintenance = gate.runMaintenance(async () => {
        order.push("maintenance");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseCheck?.();
    await check;
    await maintenance;
    expect(order).toEqual(["check-end", "maintenance"]);
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
