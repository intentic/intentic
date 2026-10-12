// Leaving a shared sandbox is two records, and the daemon's is the one that grants: it is asked first, through the session
// that proves who is leaving, then the platform's row goes. A sandbox that cannot be asked still lets the person leave their
// own account's list, and says what is left standing.
import type { SandboxSummary } from "@intentic/api-contract";

const calls: string[] = [];
const retireSandboxAccess = jest.fn<(sandbox: SandboxSummary) => Promise<void>>();
const leave = jest.fn<(input: { sandboxId: string }) => Promise<{ ok: true }>>();
jest.mock(`../../session/sandboxSession`, () => ({ useSandboxSession: () => ({ retireSandboxAccess: (sandbox: SandboxSummary) => retireSandboxAccess(sandbox) }) }));
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { sandbox: { leave: (input: { sandboxId: string }) => leave(input) } } }));

const { leaveSandbox } = await import(`../leaveSandbox`);

const shared: SandboxSummary = {
    id: `sbx-1`,
    name: `Shared`,
    image: null,
    daemonUrl: `https://sandbox-1.example.test`,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    hosted: null,
    token: null,
    role: `collaborator`,
    providedAddress: false,
    localHostname: null,
};

beforeEach(() => {
    calls.length = 0;
    retireSandboxAccess.mockReset();
    leave.mockReset();
    retireSandboxAccess.mockImplementation(async () => void calls.push(`daemon`));
    leave.mockImplementation(async () => {
        calls.push(`platform`);
        return { ok: true };
    });
});

describe(`leaveSandbox`, () => {
    it(`takes the person off the sandbox's own list first, then drops the account's row`, async () => {
        expect(await leaveSandbox(shared)).toEqual({ grant: `dropped` });
        expect(calls).toEqual([`daemon`, `platform`]);
        expect(retireSandboxAccess).toHaveBeenCalledWith(shared);
        expect(leave).toHaveBeenCalledWith({ sandboxId: `sbx-1` });
    });

    it(`leaves the account's row even when the sandbox cannot be asked, and says it still lists the person`, async () => {
        retireSandboxAccess.mockRejectedValue(new Error(`access removal failed (503)`));
        expect(await leaveSandbox(shared)).toEqual({ grant: `kept`, reason: `access removal failed (503)` });
        expect(leave).toHaveBeenCalledWith({ sandboxId: `sbx-1` });
    });

    it(`gives a reason of its own when the failure carried none`, async () => {
        retireSandboxAccess.mockRejectedValue(``);
        expect(await leaveSandbox(shared)).toEqual({ grant: `kept`, reason: `The sandbox could not be reached.` });
    });

    it(`fails when the account's row cannot be dropped, after the sandbox already let the person go`, async () => {
        leave.mockRejectedValue(new Error(`platform refused`));
        await expect(leaveSandbox(shared)).rejects.toThrow(`platform refused`);
        expect(retireSandboxAccess).toHaveBeenCalledTimes(1);
    });
});
