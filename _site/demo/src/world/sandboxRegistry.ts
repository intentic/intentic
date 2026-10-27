import type { BootReport, SandboxHosted, SandboxSummary, SetupCode, SetupReport, TrashedSandbox } from "@intentic/api-contract";
import { DEMO_SANDBOXES, DEMO_TRASH } from "./account";
import { declineLocalShortcut } from "./browserSeeds";

// THE ACCOUNT'S SANDBOXES AS LIVE STATE: the rows the platform lists, the trash a delete fills, and the setup codes it
// mints. The platform's procedures (platform.ts) and the machines that redeem a code (world/machines.ts) both write here,
// so what the editor reads back after a press is what that press did, until the page reloads.

const DAY_MS = 86_400_000;
// How long a deleted sandbox stays restorable, as the platform keeps it (api-contract `TRASH_DAYS`).
const TRASH_DAYS = 7;
// A setup code's life on the real platform (setup-code.ts `SETUP_CODE_TTL_MS`).
const SETUP_CODE_TTL_MS = 30 * 60_000;

const rows: SandboxSummary[] = DEMO_SANDBOXES.map((row) => ({ ...row }));
const trash: TrashedSandbox[] = [...DEMO_TRASH];
// The rows the visitor made on this page: each one is a sandbox on its first day (world/fresh.ts serves it so).
const madeHere = new Set<string>();
// A minted code, by its own text: the row it was minted for and the address its machine will announce at.
const codes = new Map<string, { readonly sandboxId: string; readonly hostname: string }>();

const hex = (length: number): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2))), (byte) => byte.toString(16).padStart(2, `0`))
        .join(``)
        .slice(0, length);

/** Every row the account lists, as copies: a reader never holds the live one. */
export const sandboxRows = (): SandboxSummary[] => rows.map((row) => ({ ...row }));

export const rowOf = (id: string): SandboxSummary | undefined => rows.find((row) => row.id === id);

/** The row whose daemon answers at this origin, if the account lists one there. */
export const rowAt = (origin: string): SandboxSummary | undefined =>
    rows.find((row) => row.daemonUrl !== null && new URL(row.daemonUrl).origin === origin);

/** Whether the visitor made this sandbox on this page, so it has nothing in it yet. */
export const madeOnThisPage = (id: string): boolean => madeHere.has(id);

const patch = (id: string, change: Partial<SandboxSummary>): SandboxSummary | undefined => {
    const index = rows.findIndex((row) => row.id === id);
    const row = rows[index];
    if (row === undefined) {
        return undefined;
    }
    const next = { ...row, ...change };
    rows[index] = next;
    return next;
};

// A new row as `mintSandbox` makes one: the owner's, with its connect token, and nothing reported about it yet.
const blankRow = (id: string, name: string, image: string | null = null): SandboxSummary => ({
    id,
    name,
    image,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    token: `demo-connect-${hex(16)}`,
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    hosted: null,
});

/** sandbox.create: a row under the typed name, nothing provisioned yet. Names need not be unique, as on the platform. */
export const createRow = (name: string): SandboxSummary => {
    const row = blankRow(`sbx-${hex(10)}`, name);
    rows.push(row);
    madeHere.add(row.id);
    declineLocalShortcut(row.id);
    return { ...row };
};

/** sandbox.update: a new name, a new logo, or the logo cleared (`null`); an absent field is left as it was. */
export const updateRow = (id: string, change: { readonly name?: string | undefined; readonly image?: string | null | undefined }): SandboxSummary | undefined => {
    const next: Partial<SandboxSummary> = {};
    if (change.name !== undefined) {
        next.name = change.name;
    }
    if (change.image !== undefined) {
        next.image = change.image;
    }
    return patch(id, next);
};

/** sandbox.delete: the identity goes now, and the trash keeps a way back for a week. */
export const deleteRow = (id: string): boolean => {
    const index = rows.findIndex((row) => row.id === id);
    const row = rows[index];
    if (row === undefined) {
        return false;
    }
    rows.splice(index, 1);
    const now = Date.now();
    trash.unshift({
        id: `trash-${hex(10)}`,
        name: row.name,
        image: row.image,
        deletedAt: new Date(now).toISOString(),
        purgeAfter: new Date(now + TRASH_DAYS * DAY_MS).toISOString(),
        hosted: row.hosted !== null,
    });
    return true;
};

/**
 * invite.accept: someone else's sandbox joins the list under the role the invite granted. Already running and already
 * full of its owner's work, so it is not one of the rows made on this page; a member's row carries no connect token.
 */
export const joinRow = (name: string, role: SandboxSummary[`role`]): SandboxSummary => {
    const row: SandboxSummary = {
        ...blankRow(`sbx-${hex(10)}`, name),
        role,
        token: null,
        daemonUrl: `https://${sandboxHostname()}`,
        lastSeenAt: new Date().toISOString(),
    };
    rows.push(row);
    declineLocalShortcut(row.id);
    return { ...row };
};

/** sandbox.leave: a member's row goes from their list; the sandbox itself is untouched. */
export const leaveRow = (id: string): void => {
    const index = rows.findIndex((row) => row.id === id && row.role !== `owner`);
    if (index >= 0) {
        rows.splice(index, 1);
    }
};

export const trashRows = (): TrashedSandbox[] => [...trash];

/**
 * sandbox.restore: the name comes back under a NEW identity, as the platform restores one. A machine of ours comes back
 * with its disk, awake; an own-machine sandbox comes back as a name whose setup is run again.
 */
export const restoreRow = (trashId: string): SandboxSummary | undefined => {
    const index = trash.findIndex((entry) => entry.id === trashId);
    const entry = trash[index];
    if (entry === undefined) {
        return undefined;
    }
    trash.splice(index, 1);
    const row = blankRow(`sbx-${hex(10)}`, entry.name, entry.image);
    const restored: SandboxSummary = entry.hosted
        ? { ...row, hosted: { state: `awake`, region: `arn`, warm: true }, daemonUrl: `https://${sandboxHostname()}`, lastSeenAt: new Date().toISOString() }
        : row;
    rows.push(restored);
    madeHere.add(restored.id);
    declineLocalShortcut(restored.id);
    return { ...restored };
};

/** The address a new sandbox of this account answers at: under the reserved TLD, so nothing can leave the page. */
export const sandboxHostname = (): string => `sandbox-${hex(12)}.demo.invalid`;

/** sandbox.setupCode: a fresh code for the row, which forgets whatever an earlier run reported. */
export const mintSetupCode = (sandboxId: string): SetupCode | undefined => {
    const row = rowOf(sandboxId);
    if (row === undefined) {
        return undefined;
    }
    const held = row.daemonUrl === null ? sandboxHostname() : new URL(row.daemonUrl).hostname;
    const code = `IC-${hex(4).toUpperCase()}-${hex(4).toUpperCase()}`;
    codes.set(code, { sandboxId, hostname: held });
    patch(sandboxId, { setupCodeClaimedAt: null, setupReport: null });
    return { code, hostname: held, expiresAt: new Date(Date.now() + SETUP_CODE_TTL_MS).toISOString() };
};

/** The row a code was minted for, and the address it names. */
export const codeOf = (code: string): { readonly sandboxId: string; readonly hostname: string } | undefined => codes.get(code);

/** The latest code minted for a row. */
export const latestCodeFor = (sandboxId: string): string | undefined => [...codes].findLast(([, minted]) => minted.sandboxId === sandboxId)?.[0];

/** A machine redeemed the code: the platform records the claim. */
export const claimCode = (sandboxId: string): void => {
    patch(sandboxId, { setupCodeClaimedAt: new Date().toISOString() });
};

/** The machine's account of its setup run, as `ic sandbox connect` posts it stage by stage. */
export const reportSetup = (sandboxId: string, stage: SetupReport[`stage`]): void => {
    patch(sandboxId, { setupReport: { stage, failed: [], at: new Date().toISOString() } });
};

/** The daemon announced itself at its address: the check-in the registry watch opens the workspace on. */
export const checkIn = (sandboxId: string, daemonUrl: string): void => {
    patch(sandboxId, { daemonUrl, lastSeenAt: new Date().toISOString(), announceRefusal: null, daemonVersion: `demo` });
};

/** The daemon's own word on its boot: reachability and how far its chain has come. */
export const reportBoot = (sandboxId: string, report: Omit<BootReport, `at`>): void => {
    patch(sandboxId, { bootReport: { ...report, at: new Date().toISOString() } });
};

/** sandbox.attach: an address that already answers, recorded on the row (it reported in by answering the probe). */
export const attachRow = (sandboxId: string, daemonUrl: string): SandboxSummary | undefined =>
    patch(sandboxId, { daemonUrl, providedAddress: true, lastSeenAt: new Date().toISOString() });

/** A machine of ours placed on the row, or taken off it (`null`). */
export const placeHosted = (sandboxId: string, hosted: SandboxHosted | null): SandboxSummary | undefined => patch(sandboxId, { hosted });
