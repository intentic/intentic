import type { Capability, FleetConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import type { CapabilityCtx } from "../capability.js";
import { fleetHandler } from "./fleet.handler.js";

// A token the editor minted for the card belongs to it: the card going, or its token being replaced, revokes it. A
// token pasted in might be the owner's for another sandbox too, so it is never revoked from here.

const WHO = { status: 200, body: JSON.stringify({ email: `owner@example.test`, label: `Sandbox fleet: storefront` }) };

const fakeCtx = (stored?: FleetConfig, release = { status: 200, body: `{"revoked":true}` }) => {
    const released: string[] = [];
    const warnings: string[] = [];
    const ctx = unstubbed<CapabilityCtx>(`fleet ctx`, {
        fleetWhoami: async (token: string) => (token.startsWith(`itk_`) ? WHO : { status: 401, body: `{"error":"revoked"}` }),
        fleetRelease: async (token: string) => {
            released.push(token);
            return release;
        },
        capabilities: unstubbed<CapabilityCtx["capabilities"]>(`capabilities`, {
            get: async (id: string): Promise<Capability | undefined> => (stored === undefined ? undefined : { id, kind: `fleet`, config: stored }),
        }),
        logger: unstubbed<CapabilityCtx["logger"]>(`logger`, {
            warn: (...line: Parameters<CapabilityCtx["logger"]["warn"]>) => void warnings.push(String(line[1])),
        }),
    });
    return { ctx, released, warnings };
};

const drain = async (frames: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of frames) {
        // the apply's log lines
    }
};

test(`removing the card revokes a token minted for it, and leaves a pasted one alone`, async () => {
    const minted = fakeCtx();
    await fleetHandler.remove?.(minted.ctx, `fleet`, { token: `itk_minted`, tokenId: `tok-1` });
    expect(minted.released).toEqual([`itk_minted`]);

    const pasted = fakeCtx();
    await fleetHandler.remove?.(pasted.ctx, `fleet`, { token: `itk_pasted` });
    expect(pasted.released).toEqual([]);
});

test(`a platform that cannot revoke it never holds the removal up, and says why in the log`, async () => {
    const { ctx, warnings } = fakeCtx(undefined, { status: 502, body: `{"error":"the platform could not be reached, the token was not revoked"}` });
    await fleetHandler.remove?.(ctx, `fleet`, { token: `itk_minted`, tokenId: `tok-1` });
    expect(warnings).toEqual([`fleet: the token minted for this card was not revoked (its card was removed): the platform could not be reached, the token was not revoked`]);
});

test(`a new token that verifies replaces a minted one, which is revoked; one the platform refuses replaces nothing`, async () => {
    const replaced = fakeCtx({ token: `itk_old`, tokenId: `tok-old` });
    await drain(fleetHandler.apply(replaced.ctx, `fleet`, { token: `itk_new`, tokenId: `tok-new` }));
    expect(replaced.released).toEqual([`itk_old`]);

    const refused = fakeCtx({ token: `itk_old`, tokenId: `tok-old` });
    await drain(fleetHandler.apply(refused.ctx, `fleet`, { token: `bad` }));
    expect(refused.released).toEqual([]);

    // Saving the same token again (an edit that changed nothing) is not a replacement.
    const same = fakeCtx({ token: `itk_old`, tokenId: `tok-old` });
    await drain(fleetHandler.apply(same.ctx, `fleet`, { token: `itk_old`, tokenId: `tok-old` }));
    expect(same.released).toEqual([]);
});

test(`the list is told the token's platform id, never the token`, () => {
    expect(fleetHandler.echo({ token: `itk_minted`, tokenId: `tok-1` }, new Map())).toEqual({ hasToken: true, tokenId: `tok-1` });
    expect(fleetHandler.echo({ token: `itk_pasted` }, new Map())).toEqual({ hasToken: true });
});

test(`the minted token's id follows that token: kept across a save that left it out, dropped once another token replaces it`, async () => {
    const { ctx } = fakeCtx({ token: `itk_minted`, tokenId: `tok-1` });
    await expect(fleetHandler.installed?.(ctx, `fleet`, { token: `itk_minted` })).resolves.toEqual({ token: `itk_minted`, tokenId: `tok-1` });
    await expect(fleetHandler.installed?.(ctx, `fleet`, { token: `itk_pasted`, tokenId: `tok-1` })).resolves.toEqual({ token: `itk_pasted` });
    await expect(fleetHandler.installed?.(ctx, `fleet`, { token: `itk_again`, tokenId: `tok-2` })).resolves.toEqual({ token: `itk_again`, tokenId: `tok-2` });
});
