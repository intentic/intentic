import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../context.js";
import { billingRoutes } from "./billing.routes.js";

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };

// Minimal prisma fake: each test overrides just the calls its route makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: {
            webOrigin: `https://app.test`,
            stripe: { secretKey: ``, proPriceId: `` },
            intenticCloudflare: { apiToken: ``, zone: `` },
            secrets: { key: `` },
            email: { apiKey: ``, from: `` },
            permanentPremiumEmails: [],
        },
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
    }) as OrpcContext;

describe(`billing routes`, () => {
    it(`billing.plan resolves the tier from the persisted subscription`, async () => {
        const free = fakePrisma({ subscription: { findFirst: vi.fn().mockResolvedValue(null) } });
        expect(await call(billingRoutes.plan, undefined, { context: context({ prisma: free }) })).toEqual({
            plan: `free`,
            entitlements: { sandboxLimit: 1, sandboxSharing: false },
        });

        const pro = fakePrisma({ subscription: { findFirst: vi.fn().mockResolvedValue({ status: `active` }) } });
        expect(await call(billingRoutes.plan, undefined, { context: context({ prisma: pro }) })).toEqual({
            plan: `pro`,
            entitlements: { sandboxSharing: true },
        });
    });

    it(`permanent-premium emails resolve to pro without any subscription`, async () => {
        const findFirst = vi.fn().mockResolvedValue(null);
        const prisma = fakePrisma({ subscription: { findFirst } });
        // owner@example.com is the test caller; matched case-insensitively.
        const config = { ...context().config, permanentPremiumEmails: [`owner@example.com`] };
        expect(await call(billingRoutes.plan, undefined, { context: context({ prisma, config }) })).toEqual({
            plan: `pro`,
            entitlements: { sandboxSharing: true },
        });
        expect(findFirst).not.toHaveBeenCalled();
    });
});
