import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import type { SandboxPasswords } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { STARTED_AT } from "../board/roster";

// The hosted Passwords view's three reads: what the owner's keyrings share with this sandbox (the bank PIN and the VPN
// login the Secrets page already shows on rog), what agents asked for by place, and this sandbox's uses of them.

const HOUR = 3_600_000;
const SANDBOX = `https://sandbox-acme-shop.sbx.intentic.dev`;

export const demoPasswords = (): SandboxPasswords => ({
    sandbox: SANDBOX,
    items: [
        {
            name: `bank-pin`,
            title: `Bank PIN`,
            kind: `password`,
            origins: [{ kind: `site`, host: `online.acmebank.example` }],
            anyField: false,
            machine: `rog`,
            mode: `each-use`,
            online: true,
            updatedAt: STARTED_AT - 40 * 24 * HOUR,
            lastUsedAt: STARTED_AT - 26 * HOUR,
        },
        {
            name: `forticlient`,
            title: `Office VPN`,
            kind: `password`,
            origins: [{ kind: `program`, program: `FortiClient.exe`, label: `FortiClient VPN` }],
            anyField: false,
            machine: `rog`,
            mode: `while-here`,
            online: true,
            updatedAt: STARTED_AT - 12 * 24 * HOUR,
            lastUsedAt: STARTED_AT - 26 * HOUR,
        },
        {
            name: `npm-publish`,
            title: `npm (acme)`,
            kind: `password`,
            origins: [{ kind: `site`, host: `www.npmjs.com` }],
            anyField: false,
            machine: `rog`,
            mode: `each-use`,
            online: true,
            updatedAt: STARTED_AT - 3 * 24 * HOUR,
        },
    ],
    keyrings: [
        { machine: `rog`, online: true, setUp: true, locked: false, remember: { browser: true, terminal: true, apps: true, phone: false, sandbox: true } },
        { machine: `omen`, online: false, setUp: true, locked: true },
    ],
});

export const demoPasswordNeeds = (): SandboxHandlerOutput<`secrets`, `passwordNeeds`> => ({
    needs: [
        {
            id: `need-stripe-dashboard`,
            origin: { kind: `site`, host: `dashboard.stripe.com` },
            username: `ada@acme.dev`,
            detail: `Check last night's refunds in the Stripe dashboard`,
            conversation: `refund-audit`,
            machine: `rog`,
            state: `pending`,
            at: STARTED_AT - 6 * 60_000,
        },
        {
            id: `need-vpn`,
            origin: { kind: `program`, program: `FortiClient.exe`, label: `FortiClient VPN` },
            detail: `Reach the office GitLab over the VPN to mirror the shop's repositories`,
            machine: `rog`,
            state: `allowed`,
            name: `forticlient`,
            at: STARTED_AT - 27 * HOUR,
        },
    ],
});

export const demoPasswordActivity = (): SandboxHandlerOutput<`secrets`, `passwordActivity`> => ({
    lines: [
        { at: STARTED_AT - 26 * HOUR, name: `forticlient`, lane: `device`, detail: `rog · FortiClient.exe` },
        { at: STARTED_AT - 26 * HOUR + 4 * 60_000, name: `bank-pin`, lane: `device`, detail: `rog · chrome.exe`, approvedBy: `ada@acme.dev` },
    ],
});
