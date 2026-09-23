import { resetSandboxScope } from "@intentic/extension-api";
import type { PresenceUser } from "@intentic/sandbox-contract";
import { runAllTimersAsync } from "@intentic/testing/bun";
import { ref } from "vue";
import type { ProcedureInput } from "../../features/sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const requestMock = jest.fn(async (_report: ProcedureInput<`system.presence`>) => ({ ok: true as const }));
jest.mock("../../features/sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ system: { presence: requestMock } }) }));
jest.mock("../../features/auth/useAuth", () => ({ useAuth: () => ({ user: ref({ id: `u`, email: `Me@x.com`, name: `Me`, image: null }) }) }));
const { presenceOthers, presenceStreamOpened, reportOpenPath, reportView, clearPresence, setPresenceUsers, viewersOfPath, viewersOfSession } =
    await import("./usePresence");

const tab = (overrides: Partial<PresenceUser> & { clientId: string; email: string }): PresenceUser => ({
    idle: false,
    role: `collaborator`,
    ...overrides,
});

describe(`presence roster`, () => {
    afterEach(() => clearPresence());

    it(`aggregates a member's tabs into one entry, idle only when EVERY tab is idle, self excluded (case-insensitive)`, () => {
        setPresenceUsers([
            tab({ clientId: `c1`, email: `a@x.com`, name: `Ada`, idle: true }),
            tab({ clientId: `c2`, email: `a@x.com`, idle: false }),
            tab({ clientId: `me`, email: `me@x.com` }),
        ]);
        expect(presenceOthers.value).toHaveLength(1);
        expect(presenceOthers.value[0]).toMatchObject({ email: `a@x.com`, name: `Ada`, idle: false });
        setPresenceUsers([tab({ clientId: `c1`, email: `a@x.com`, idle: true }), tab({ clientId: `c2`, email: `a@x.com`, idle: true })]);
        expect(presenceOthers.value[0]?.idle).toBe(true);
    });

    it(`sorts active members ahead of idle ones`, () => {
        setPresenceUsers([tab({ clientId: `c1`, email: `a@x.com`, idle: true }), tab({ clientId: `c2`, email: `b@x.com`, idle: false })]);
        expect(presenceOthers.value.map((member) => member.email)).toEqual([`b@x.com`, `a@x.com`]);
    });

    it(`finds viewers by path and session; clearPresence clears the roster`, () => {
        setPresenceUsers([tab({ clientId: `c1`, email: `a@x.com`, path: `src/app.ts` }), tab({ clientId: `c2`, email: `b@x.com`, sessionId: `s1` })]);
        expect(viewersOfPath(`src/app.ts`).map((member) => member.email)).toEqual([`a@x.com`]);
        expect(viewersOfPath(`other.ts`)).toEqual([]);
        expect(viewersOfSession(`s1`).map((member) => member.email)).toEqual([`b@x.com`]);
        clearPresence();
        expect(presenceOthers.value).toEqual([]);
    });

    // The roster is the outgoing daemon's; the incoming sandbox's stream repaints its own on connect.
    it(`starts empty in the next sandbox`, () => {
        setPresenceUsers([tab({ clientId: `c1`, email: `a@x.com` })]);
        resetSandboxScope();
        expect(presenceOthers.value).toEqual([]);
    });
});

describe(`presence reporter`, () => {
    beforeEach(() => {
        jest.useFakeTimers();
        requestMock.mockClear();
    });
    afterEach(() => {
        jest.runAllTimers();
        jest.useRealTimers();
        clearPresence();
    });

    it(`debounces a burst into one report and dedupes an unchanged one`, async () => {
        presenceStreamOpened(`conn-1`);
        await runAllTimersAsync();
        requestMock.mockClear();
        reportView(`workspace`);
        reportOpenPath(`src/app.ts`);
        await runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledWith({ clientId: `conn-1`, idle: false, view: `workspace`, path: `src/app.ts` });
        // Same state again → deduped, no second POST.
        reportView(`workspace`);
        await runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it(`re-announces on a new connection id even when the state is unchanged`, async () => {
        presenceStreamOpened(`conn-2`);
        await runAllTimersAsync();
        const reports = requestMock.mock.calls.map(([report]) => report);
        expect(reports.at(-1)?.clientId).toBe(`conn-2`);
        requestMock.mockClear();
        // The reconnect: same activity, fresh connection, must re-send under the new id.
        presenceStreamOpened(`conn-3`);
        await runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock.mock.calls[0]![0]).toMatchObject({ clientId: `conn-3` });
    });

    it(`self-heals when its own roster entry arrives blank (report raced the registration)`, async () => {
        presenceStreamOpened(`conn-4`);
        reportView(`workspace`);
        await runAllTimersAsync();
        requestMock.mockClear();
        // The daemon's snapshot shows OUR connection with no view: the report was dropped; expect a re-send.
        setPresenceUsers([tab({ clientId: `conn-4`, email: `me@x.com` })]);
        await runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(requestMock.mock.calls[0]![0]).toMatchObject({ clientId: `conn-4`, view: `workspace` });
    });
});
