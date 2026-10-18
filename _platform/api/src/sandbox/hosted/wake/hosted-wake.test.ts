import type { PrismaClient } from "@intentic/prisma";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import { HostedMachineBusy } from "../gate/state-gate.js";
import { FlyError } from "../fly/fly.js";
import { hostedWakeConfig, hostedWakeSandbox } from "./hosted-wake.testing.js";
import * as hostedOriginal from "../hosted.js";
import * as usageOriginal from "../hosted-usage.js";

const wakeHosted = jest.fn(async (..._args: Parameters<typeof hostedOriginal.wakeHosted>) => false);
const forgetHostedMachine = jest.fn(async (..._args: Parameters<typeof hostedOriginal.forgetHostedMachine>) => {});
jest.mock("../hosted.js", () => ({ ...hostedOriginal, wakeHosted, forgetHostedMachine }));
const settleHostedStretch = jest.fn(async (..._args: Parameters<typeof usageOriginal.settleHostedStretch>) => {});
const hostedBudgetOf = jest.fn(async (..._args: Parameters<typeof usageOriginal.hostedBudgetOf>): Promise<usageOriginal.HostedBudget> => ({
    kind: "free", tier: "free", metered: true, allowanceMinutes: 600, remainingMinutes: 600, usedMinutes: 0,
}));
const openHostedStretch = jest.fn(async (..._args: Parameters<typeof usageOriginal.openHostedStretch>) => true);
jest.mock("../hosted-usage.js", () => ({ ...usageOriginal, settleHostedStretch, hostedBudgetOf, openHostedStretch }));
const { wakeHostedSandbox } = await import("./hosted-wake.js");

const logger = pino({ level: "silent" });
const context = (suspended = false) => {
    const owner = jest.fn(async () => ({
        hostedSuspendedAt: suspended ? new Date(0) : null, hostedSuspendedReason: suspended ? "acceptable use" : null,
        email: "owner@example.com", accounts: [],
    }));
    const stamp = jest.fn(async () => ({}));
    // SAFETY: standing reads only this user projection and the carried-standing lookup, and a person's wake writes only
    // its stamp; the meter is the seam above.
    const prisma = unstubbed<PrismaClient>("prisma", {
        sandbox: unstubbed<PrismaClient["sandbox"]>("prisma.sandbox", { update: stamp as never }),
        user: unstubbed<PrismaClient["user"]>("prisma.user", { findUnique: owner as never }),
        hostedStanding: unstubbed<PrismaClient["hostedStanding"]>("prisma.hostedStanding", { findUnique: jest.fn(async () => null) as never }),
    });
    return { prisma, config: hostedWakeConfig(), logger, owner, stamp };
};

afterEach(() => { jest.clearAllMocks(); });

test("an alarm wake uses the owner's standing, settles the old stretch, checks hours and opens the new one", async () => {
    const ctx = context();
    const sandbox = hostedWakeSandbox();
    await wakeHostedSandbox(ctx, sandbox);
    expect(ctx.owner).toHaveBeenCalledWith({ where: { id: "u1" }, select: {
        hostedSuspendedAt: true, hostedSuspendedReason: true, email: true,
        accounts: { where: { providerId: "google" }, select: { accountId: true } },
    } });
    expect(settleHostedStretch).toHaveBeenCalledWith(ctx.prisma, ctx.config, logger, { ...sandbox.hosted, ownerId: "u1" });
    expect(hostedBudgetOf).toHaveBeenCalledWith(ctx.prisma, ctx.config, { sandboxId: "s1", ownerId: "u1" });
    expect(wakeHosted).toHaveBeenCalledTimes(1);
    const [, machine, heal, , record] = wakeHosted.mock.calls[0]!;
    expect(machine).toEqual(sandbox.hosted);
    expect(heal?.()).toEqual({ sandboxId: "s1", connectToken: "connect-s1", ownerEmail: "owner@example.com", region: "iad", tier: "free" });
    expect(record).toEqual({ prisma: ctx.prisma, hostedMachineId: "h-s1", sandboxId: "s1" });
    expect(openHostedStretch).toHaveBeenCalledWith(ctx.prisma, { ...sandbox.hosted, ownerId: "u1" }, { keepIdleWarning: false });
    expect(settleHostedStretch.mock.invocationCallOrder[0]).toBeLessThan(hostedBudgetOf.mock.invocationCallOrder[0]!);
    expect(hostedBudgetOf.mock.invocationCallOrder[0]).toBeLessThan(wakeHosted.mock.invocationCallOrder[0]!);
    expect(wakeHosted.mock.invocationCallOrder[0]).toBeLessThan(openHostedStretch.mock.invocationCallOrder[0]!);
});

// Only a person withdraws an idle notice: an alarm starting the machine for its schedules is nobody opening it.
test("an alarm's start leaves a standing idle notice where a person's wake withdraws it", async () => {
    const ctx = context();
    await wakeHostedSandbox(ctx, hostedWakeSandbox(), "alarm");
    expect(openHostedStretch).toHaveBeenLastCalledWith(ctx.prisma, expect.anything(), { keepIdleWarning: true });
    // Nor is it somebody there: only a person's wake moves the stamp idle collection measures from.
    expect(ctx.stamp).not.toHaveBeenCalled();
    await wakeHostedSandbox(ctx, hostedWakeSandbox());
    expect(ctx.stamp).toHaveBeenCalledWith({ where: { id: "s1" }, data: { personSeenAt: expect.any(Date) } });
});

test("a suspended owner refuses an alarm before reading hours or starting a machine", async () => {
    await expect(wakeHostedSandbox(context(true), hostedWakeSandbox())).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(settleHostedStretch).not.toHaveBeenCalled();
    expect(hostedBudgetOf).not.toHaveBeenCalled();
    expect(wakeHosted).not.toHaveBeenCalled();
    expect(openHostedStretch).not.toHaveBeenCalled();
});

test("spent hours refuse an alarm with the same payment response as a browser wake", async () => {
    hostedBudgetOf.mockResolvedValueOnce({ kind: "free", tier: "free", metered: true, allowanceMinutes: 600, remainingMinutes: 0, usedMinutes: 600 });
    await expect(wakeHostedSandbox(context(), hostedWakeSandbox())).rejects.toMatchObject({ code: "PAYMENT_REQUIRED", status: 402 });
    expect(wakeHosted).not.toHaveBeenCalled();
    expect(openHostedStretch).not.toHaveBeenCalled();
});

test.each([
    [new HostedMachineBusy("change in progress"), "CONFLICT", 409],
    [new Error("provider unavailable"), "BAD_GATEWAY", 502],
] as const)("a failed start cannot open a billed stretch (%s)", async (error, code, status) => {
    wakeHosted.mockRejectedValueOnce(error);
    await expect(wakeHostedSandbox(context(), hostedWakeSandbox())).rejects.toMatchObject({ code, status, message: error.message });
    expect(openHostedStretch).not.toHaveBeenCalled();
    expect(forgetHostedMachine).not.toHaveBeenCalled();
});

test("a missing provider machine is forgotten and its alarm wake reports not found", async () => {
    const ctx = context();
    const sandbox = hostedWakeSandbox();
    wakeHosted.mockRejectedValueOnce(new FlyError("machine gone", 404));
    await expect(wakeHostedSandbox(ctx, sandbox)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(forgetHostedMachine).toHaveBeenCalledWith(ctx.prisma, { ...sandbox.hosted, ownerId: "u1" });
    expect(openHostedStretch).not.toHaveBeenCalled();
});
