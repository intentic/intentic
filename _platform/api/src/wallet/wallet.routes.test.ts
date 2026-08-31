import { createHash } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { expect, it, vi } from "vitest";
import { type Config, configSchema } from "../config.js";
import type { CustodyGateway } from "./wallet-custody.js";
import { walletHttpRoutes } from "./wallet.routes.js";

/* THE SIGNER IS THE ONLY REAL FENCE around an agent's spending: the daemon's own checks are UX, and the
 * container they run in is not a trust boundary, so what is pinned here is what a compromised or
 * prompt-injected sandbox must NOT be able to obtain: a signature over more than the owner's per-payment
 * ceiling, one that passes the day's cap, one that spends somebody else's wallet, one over a token that is
 * not USDC, or one whose validity window is long enough to be worth stealing. Each of those is a request
 * this route family answers with a refusal rather than a signature. */

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const NOW = new Date(`2026-08-19T12:00:00Z`);
const ADDRESS = `0x857b06519E91e3A54538791bDbb0E22373e36b66`;
const PAY_TO = `0x209693Bc6afc0C5328bA36FaF03C514EF312287C`;
const USDC_BASE = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;

const config: Config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    wallet: { custodyUrl: `https://custody.test`, custodyKey: `ck_test` },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface StoredWallet {
    id: string;
    userId: string;
    network: string;
    address: string;
    providerWalletId: string;
    perPaymentMaxUsd: string;
    dailyCapUsd: string;
}
interface StoredPayment {
    id: string;
    walletId: string;
    userId: string;
    day: string;
    amountUsd: string;
    host: string;
    payTo: string;
}

// Enough Prisma for these routes: the sandbox token lookup, the wallet row, and the payment ledger the
// daily cap is computed from: with $transaction running its callback for real, since the cap check and the
// row write happening together is exactly the property under test.
const fakePrisma = (seed?: { wallets?: StoredWallet[]; payments?: StoredPayment[] }) => {
    const wallets = seed?.wallets ?? [];
    const payments = seed?.payments ?? [];
    let next = 0;
    const walletDelegate = {
        findUnique: vi.fn(async ({ where }: { where: { userId_network: { userId: string; network: string } } }) => {
            const key = where.userId_network;
            return wallets.find((row) => row.userId === key.userId && row.network === key.network) ?? null;
        }),
        create: vi.fn(async ({ data }: { data: Omit<StoredWallet, `id`> }) => {
            const row = { id: `wallet-${(next += 1)}`, ...data };
            wallets.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<StoredWallet> }) => {
            const index = wallets.findIndex((row) => row.id === where.id);
            wallets[index] = { ...wallets[index]!, ...data };
            return wallets[index];
        }),
    };
    const paymentDelegate = {
        findMany: vi.fn(async ({ where }: { where: { walletId: string; day: string } }) =>
            payments.filter((row) => row.walletId === where.walletId && row.day === where.day).map((row) => ({ amountUsd: row.amountUsd })),
        ),
        create: vi.fn(async ({ data }: { data: Omit<StoredPayment, `id`> }) => {
            const row = { id: `pay-${(next += 1)}`, ...data };
            payments.push(row);
            return { id: row.id };
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
            const index = payments.findIndex((row) => row.id === where.id);
            if (index >= 0) {
                payments.splice(index, 1);
            }
            return {};
        }),
    };
    const prisma = {
        sandbox: {
            findUnique: vi.fn(async ({ where }: { where: { tokenDigest: string } }) =>
                where.tokenDigest === digestOf(`tok`) ? { ownerId: `user-1` } : null,
            ),
        },
        wallet: walletDelegate,
        walletPayment: paymentDelegate,
        $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ wallet: walletDelegate, walletPayment: paymentDelegate })),
    };
    return { prisma: prisma as unknown as PrismaClient, wallets, payments };
};

const custody = (over: Partial<CustodyGateway> = {}): CustodyGateway => ({
    wallet: async () => ({ id: `cw-1`, address: ADDRESS }),
    signTypedData: async () => `0x${`ab`.repeat(65)}`,
    ...over,
});

const app = (deps: { prisma: PrismaClient; custody?: CustodyGateway; config?: Config }) => {
    const routes = walletHttpRoutes({ config: deps.config ?? config, prisma: deps.prisma, custody: deps.custody ?? custody(), now: () => NOW });
    return (path: string, body: unknown, token = `tok`) =>
        routes.request(path, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": token },
            body: JSON.stringify(body),
        });
};

const seededWallet: StoredWallet = {
    id: `wallet-1`,
    userId: `user-1`,
    network: `eip155:8453`,
    address: ADDRESS,
    providerWalletId: `cw-1`,
    perPaymentMaxUsd: `1.00`,
    dailyCapUsd: `5.00`,
};

// A well-formed authorization for $0.10, inside every default cap: the baseline each test perturbs.
const signBody = (over: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}) => ({
    network: `eip155:8453`,
    asset: USDC_BASE,
    domainName: `USD Coin`,
    domainVersion: `2`,
    amountUsd: `0.10`,
    host: `api.example.com`,
    authorization: {
        from: ADDRESS,
        to: PAY_TO,
        value: `100000`,
        validAfter: String(Math.floor(NOW.getTime() / 1000) - 60),
        validBefore: String(Math.floor(NOW.getTime() / 1000) + 60),
        nonce: `0x${`f3`.repeat(32)}`,
        ...authOver,
    },
    ...over,
});

it("signs a payment inside the caps, and records it against the day", async () => {
    const { prisma, payments } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { signature: string }).signature).toMatch(/^0x[0-9a-f]{130}$/);
    // The row is what tomorrow's cap arithmetic reads, and it is written with the payment, not after it.
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ day: `2026-08-19`, amountUsd: `0.10`, host: `api.example.com`, payTo: PAY_TO });
});

it("signs exactly the EIP-3009 typed data, in the token's own domain", async () => {
    const seen: unknown[] = [];
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    await app({
        prisma,
        custody: custody({
            signTypedData: async (_id, typedData) => {
                seen.push(typedData);
                return `0x${`ab`.repeat(65)}`;
            },
        }),
    })(`/sign`, signBody());
    expect(seen[0]).toMatchObject({
        primaryType: `TransferWithAuthorization`,
        // chainId and verifyingContract come from the PLATFORM's own table, never from the caller: a
        // challenge cannot redirect a signature onto another chain or another contract.
        domain: { name: `USD Coin`, version: `2`, chainId: 8453, verifyingContract: USDC_BASE },
        message: { from: ADDRESS, to: PAY_TO, value: `100000` },
    });
});

it("refuses a payment over the wallet's per-payment ceiling", async () => {
    const { prisma, payments } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody({ amountUsd: `2.00` }, { value: `2000000` }));
    expect(response.status).toBe(403);
    const error = ((await response.json()) as { error: string }).error;
    expect(error).toContain(`2.00`);
    expect(error).toContain(`1.00`);
    expect(payments).toHaveLength(0);
});

it("refuses a payment that would pass the day's cap, counting rows already written", async () => {
    const { prisma, payments } = fakePrisma({
        wallets: [seededWallet],
        payments: [{ id: `p1`, walletId: `wallet-1`, userId: `user-1`, day: `2026-08-19`, amountUsd: `4.95`, host: `x`, payTo: PAY_TO }],
    });
    const response = await app({ prisma })(`/sign`, signBody());
    expect(response.status).toBe(403);
    const error = ((await response.json()) as { error: string }).error;
    expect(error).toContain(`5.00`);
    expect(error).toContain(`4.95`);
    expect(payments).toHaveLength(1);
});

it("refuses to sign for a wallet that is not this account's", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody({}, { from: `0x0000000000000000000000000000000000000001` }));
    expect(response.status).toBe(403);
});

it("refuses a token that is not USDC, however well-formed the request is", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody({ asset: `0xdAC17F958D2ee523a2206206994597C13D831ec7` }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(USDC_BASE);
});

it("refuses when the stated amount and the authorization's value disagree", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    // Says ten cents, moves ten dollars: the mismatch the caps would otherwise be checked against.
    const response = await app({ prisma })(`/sign`, signBody({}, { value: `10000000` }));
    expect(response.status).toBe(400);
});

it("refuses an over-long validity window rather than trimming it", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody({}, { validBefore: String(Math.floor(NOW.getTime() / 1000) + 4000) }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/\d+s/);
});

it("refuses an already-expired authorization", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({ prisma })(`/sign`, signBody({}, { validAfter: `1000`, validBefore: String(Math.floor(NOW.getTime() / 1000) - 10) }));
    expect(response.status).toBe(400);
});

it("drops the payment row when the custody provider refuses, so a failed sign eats no budget", async () => {
    const { prisma, payments } = fakePrisma({ wallets: [seededWallet] });
    const response = await app({
        prisma,
        custody: custody({
            signTypedData: async () => {
                throw new Error(`wallet frozen`);
            },
        }),
    })(`/sign`, signBody());
    expect(response.status).toBe(502);
    expect(payments).toHaveLength(0);
});

it("answers an unknown sandbox with 404, teaching a prober nothing", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    expect((await app({ prisma })(`/sign`, signBody(), `wrong`)).status).toBe(404);
});

it("404s everything when no custody provider is configured", async () => {
    const { prisma } = fakePrisma({ wallets: [seededWallet] });
    const off = { ...config, wallet: { custodyUrl: ``, custodyKey: `` } };
    expect((await app({ prisma, config: off })(`/sign`, signBody())).status).toBe(404);
    expect(
        (await app({ prisma, config: off })(`/ensure`, { network: `eip155:8453`, policy: { perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` } })).status,
    ).toBe(404);
});

it("creates one wallet per account and network, and re-states the caps on a repeat ensure", async () => {
    const { prisma, wallets } = fakePrisma();
    const request = app({ prisma });
    const first = await request(`/ensure`, { network: `eip155:8453`, policy: { perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` } });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { address: string }).address).toBe(ADDRESS);
    // A repeat ensure is an EDIT, not a second wallet: the owner would otherwise have to fund a new address.
    const second = await request(`/ensure`, { network: `eip155:8453`, policy: { perPaymentMaxUsd: `0.25`, dailyCapUsd: `2.00` } });
    expect(second.status).toBe(200);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ perPaymentMaxUsd: `0.25`, dailyCapUsd: `2.00` });
});

it("refuses a network this platform does not sign for", async () => {
    const { prisma } = fakePrisma();
    const response = await app({ prisma })(`/ensure`, { network: `eip155:1`, policy: { perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` } });
    expect(response.status).toBe(400);
});
