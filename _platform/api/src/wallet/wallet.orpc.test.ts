import type { PrismaClient } from "@intentic/prisma";
import { call, ORPCError } from "@orpc/server";
import { expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import type { CustodyGateway } from "./wallet-custody.js";
import { walletRoutes } from "./wallet.orpc.js";

/* THE CAPS COME FROM THE OWNER'S SESSION, and this is the only door they come through (wallet.routes.test.ts
 * pins the other door shut). What is checked here: a session is required, a platform without a custody
 * provider has no caps to set, a wallet is created for the caps when the account has none, and one the sandbox
 * created first is found and updated rather than minted again. */

const user = { id: `user-1`, email: `owner@example.test`, name: `Owner`, image: null };
const ADDRESS = `0x857b06519E91e3A54538791bDbb0E22373e36b66`;
const on = { wallet: { custodyUrl: `https://custody.test`, custodyKey: `ck_test` } } as unknown as Config;
const off = { wallet: { custodyUrl: ``, custodyKey: `` } } as unknown as Config;

const custody = (): CustodyGateway => ({ wallet: vi.fn(async () => ({ id: `cw-1`, address: ADDRESS })), signTypedData: vi.fn() });

// A wallet delegate over one optional seeded row; `update` answers the caps it was handed.
const fakePrisma = (seeded?: { id: string; address: string; perPaymentMaxUsd: string; dailyCapUsd: string }) => {
    const create = vi.fn(async ({ data }: { data: Record<string, string> }) => ({ id: `wallet-new`, address: data[`address`], perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` }));
    const update = vi.fn(async ({ data }: { data: { perPaymentMaxUsd: string; dailyCapUsd: string } }) => data);
    return {
        prisma: { wallet: { findUnique: vi.fn().mockResolvedValue(seeded ?? null), create, update } } as unknown as PrismaClient,
        create,
        update,
    };
};

const context = (prisma: PrismaClient, over: Partial<OrpcContext> = {}): OrpcContext =>
    ({ prisma, config: on, user, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...over }) as unknown as OrpcContext;

const policy = { network: `eip155:8453` as const, perPaymentMaxUsd: `2.00`, dailyCapUsd: `20.00` };

it(`requires a session: a connect token is not a way in`, async () => {
    const { prisma } = fakePrisma();
    await expect(call(walletRoutes(custody()).setPolicy, policy, { context: context(prisma, { user: null }) })).rejects.toMatchObject({ code: `UNAUTHORIZED` });
});

it(`refuses on a platform with no custody provider, the routes' own 404`, async () => {
    const { prisma, create } = fakePrisma();
    const refused = await call(walletRoutes(custody()).setPolicy, policy, { context: context(prisma, { config: off }) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ORPCError);
    expect((refused as ORPCError<string, unknown>).code).toBe(`NOT_FOUND`);
    expect(create).not.toHaveBeenCalled();
});

it(`creates the account's wallet on that network when there is none, and writes the caps onto it`, async () => {
    const { prisma, create, update } = fakePrisma();
    const gateway = custody();
    expect(await call(walletRoutes(gateway).setPolicy, policy, { context: context(prisma) })).toEqual(policy);
    expect(gateway.wallet).toHaveBeenCalledWith(`user-1:eip155:8453`, `eip155:8453`);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: `user-1`, network: `eip155:8453`, address: ADDRESS }) }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `wallet-new` }, data: { perPaymentMaxUsd: `2.00`, dailyCapUsd: `20.00` } }));
});

it(`updates a wallet the sandbox brought into being first, without asking custody for another`, async () => {
    const { prisma, create, update } = fakePrisma({ id: `wallet-1`, address: ADDRESS, perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` });
    const gateway = custody();
    expect(await call(walletRoutes(gateway).setPolicy, policy, { context: context(prisma) })).toEqual(policy);
    expect(gateway.wallet).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `wallet-1` } }));
});
