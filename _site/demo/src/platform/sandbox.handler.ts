import { DEMO_SANDBOX } from "../world/account";
import { hostedPower, provisionHosted, releaseHosted, runCommandLater, wakeHosted } from "../world/machines";
import { attachRow, createRow, deleteRow, leaveRow, mintSetupCode, restoreRow, rowOf, sandboxRows, trashRows, updateRow } from "../world/sandboxRegistry";
import { FREE_TIER } from "@intentic/constants";
import { buildStatus, building, hashOf, rollBack, startBuild } from "../world/builds";
import { dropMachine, placeMachine, slotsLeft, slotsLeftAt } from "../world/plan";
import { zonesFor } from "../world/zones";
import { demoOutage } from "../outage";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE ACCOUNT'S SANDBOXES ON THE PLATFORM: the registry's procedures over the live rows of world/sandboxRegistry.ts, and the
// machines world/machines.ts plays behind them.

// A short-lived signed word the browser spends at once (an owner ticket, an identity assertion); the demo's daemon takes any.
const minted = (prefix: string) => ({ value: `${prefix}-${Date.now().toString(36)}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });

// A row the account lists, or the platform's own refusal for one it does not.
const owned = (sandboxId: string) => rowOf(sandboxId) ?? refusePlatform(`No sandbox ${sandboxId} on this account.`, 404);

// A machine of ours on the row, or the platform's refusal for a sandbox that runs elsewhere.
const hostedRow = (sandboxId: string) => {
    const row = owned(sandboxId);
    return row.hosted === null ? refusePlatform(`${row.name} does not run on a machine of ours.`, 404) : row;
};

export const sandboxAnswers = {
    list: () => ({ sandboxes: sandboxRows() }),
    create: ({ name }) => createRow(name),
    update: ({ sandboxId, name, image }) => {
        owned(sandboxId);
        return updateRow(sandboxId, { name, image }) ?? refusePlatform(`No sandbox ${sandboxId} on this account.`, 404);
    },
    delete: ({ sandboxId }) => ({ ok: deleteRow(sandboxId) }),
    trash: () => ({ sandboxes: trashRows() }),
    restore: ({ trashId }) => restoreRow(trashId) ?? refusePlatform(`That sandbox is no longer in the trash.`, 404),
    leave: ({ sandboxId }) => {
        leaveRow(sandboxId);
        return { ok: true };
    },
    hostedOffer: () => ({
        enabled: true,
        startJourney: true,
        remaining: slotsLeft(),
        hours: { allowance: FREE_TIER.monthlyHours, remaining: FREE_TIER.monthlyHours },
    }),
    // A machine stands on a slot at its rung (world/plan.ts): the free one unless the visitor bought another.
    hostedProvision: ({ sandboxId, tier = FREE_TIER.id }) => {
        if (owned(sandboxId).hosted === null) {
            if (slotsLeftAt(tier) <= 0) {
                return refusePlatform(`Your free machine is already in use. Buy another on the Billing page, or run this sandbox on your own computer.`, 409);
            }
            placeMachine(sandboxId, tier);
            provisionHosted(sandboxId);
        }
        return owned(sandboxId);
    },
    hostedRelease: ({ sandboxId }) => {
        owned(sandboxId);
        releaseHosted(sandboxId);
        dropMachine(sandboxId);
        return owned(sandboxId);
    },
    hostedStatus: ({ sandboxId }) => ({ machine: sandboxId === DEMO_SANDBOX.id ? (demoOutage === `hosted` ? `failed` : `started`) : hostedPower(sandboxId) }),
    hostedRestart: ({ sandboxId }) => {
        wakeHosted(sandboxId);
        return { ok: true };
    },
    wake: ({ sandboxId }) => {
        wakeHosted(sandboxId);
        return { ok: true };
    },
    // Addresses are minted, so the new sandbox's dialog offers the connected machines and the command for a server.
    addressOffer: () => ({ enabled: true }),
    // A fresh code for the row. Nobody can paste the command into a server from a web page, so the demo's server runs
    // it a little later unless a connected machine redeems it first (world/machines.ts `runCommandLater`).
    setupCode: ({ sandboxId }) => {
        const code = mintSetupCode(sandboxId) ?? refusePlatform(`No sandbox ${sandboxId} on this account.`, 404);
        runCommandLater(code.code);
        return code;
    },
    // The recovery panel's command carries one; nothing ever claims it here.
    fixCode: () => ({ code: `DEMOFIX7K2Q`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    // A sandbox this browser remembers that the list lacks: one made on an earlier load of the demo, which a reload
    // forgets, so the registry answers it as deleted and the editor lets go of it rather than offering it back as lost.
    lookup: ({ sandboxIds }) => ({ sandboxes: sandboxIds.map((sandboxId) => ({ sandboxId, standing: `deleted` as const })) }),
    hostedBuildStatus: ({ sandboxId }) => buildStatus(sandboxId),
    // Built from the bytes the owner approved only: content that does not hash to what they reviewed is refused.
    hostedRebuild: async ({ sandboxId, hash, content }) => {
        hostedRow(sandboxId);
        if ((await hashOf(content)) !== hash) {
            return refusePlatform(`The environment changed since you reviewed it; review it again before building.`);
        }
        if (building(sandboxId)) {
            return refusePlatform(`A build is already running for this sandbox.`, 409);
        }
        return startBuild(sandboxId, hash, content);
    },
    hostedRollback: ({ sandboxId }) => {
        hostedRow(sandboxId);
        return rollBack(sandboxId) ? { ok: true } : refusePlatform(`There is no earlier image kept for this sandbox to go back to.`, 409);
    },
    // The token is used for one listing and dropped; what it can see is the account's zones on Cloudflare (world/zones.ts).
    zones: async ({ token }) => ({ zones: await zonesFor(token) }),
    // A ticket for a sandbox the registry holds no record of. The registry here is the list: a sandbox in it is
    // somebody's already, which is the CONFLICT the platform answers rather than vouching twice.
    adoptionTicket: ({ sandboxId }) => {
        if (rowOf(sandboxId) !== undefined) {
            return refusePlatform(`This sandbox is already registered; it cannot be adopted again.`, 409);
        }
        const { value, expiresAt } = minted(`demo-adoption`);
        return { ticket: value, expiresAt };
    },
    // The setup link mailed to the owner's own address, to open on the computer that will run the sandbox. The demo
    // has no mail to send it with; the page's "sent" is what a visitor sees either way.
    emailSetupLink: ({ sandboxId }) => {
        owned(sandboxId);
        return { ok: true };
    },
    // The address the visitor's own sandbox answered the probe at (world/addresses.ts), recorded on the row.
    attach: ({ sandboxId, daemonUrl }) => attachRow(sandboxId, daemonUrl) ?? refusePlatform(`No sandbox ${sandboxId} on this account.`, 404),
    ownerTicket: ({ sandboxId }) => {
        owned(sandboxId);
        const { value, expiresAt } = minted(`demo-owner-ticket`);
        return { ticket: value, expiresAt };
    },
    identityAssertion: ({ sandboxId }) => {
        owned(sandboxId);
        const { value, expiresAt } = minted(`demo-assertion`);
        return { assertion: value, expiresAt };
    },
} satisfies NonNullable<PlatformRouter[`sandbox`]>;
