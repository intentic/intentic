import type { PresenceUser } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

vi.mock("./sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(async () => new Response()) }));
vi.mock("./useAuth", () => ({ useAuth: () => ({ user: ref({ id: `u`, email: `Me@x.com`, name: `Me`, image: null }) }) }));
const { sandboxRequest } = await import("./sandbox/sandboxClient");
const requestMock = vi.mocked(sandboxRequest);
const { presenceOthers, presenceStreamOpened, reportOpenPath, reportView, resetPresence, setPresenceUsers, viewersOfPath, viewersOfSession } =
    await import("./usePresence");

const tab = (overrides: Partial<PresenceUser> & { clientId: string; email: string }): PresenceUser => ({ idle: false, role: `collaborator`, ...overrides });

describe(`presence roster`, () => {
    afterEach(() => resetPresence());

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

    it(`finds viewers by path and session; resetPresence clears the roster`, () => {
        setPresenceUsers([tab({ clientId: `c1`, email: `a@x.com`, path: `src/app.ts` }), tab({ clientId: `c2`, email: `b@x.com`, sessionId: `s1` })]);
        expect(viewersOfPath(`src/app.ts`).map((member) => member.email)).toEqual([`a@x.com`]);
        expect(viewersOfPath(`other.ts`)).toEqual([]);
        expect(viewersOfSession(`s1`).map((member) => member.email)).toEqual([`b@x.com`]);
        resetPresence();
        expect(presenceOthers.value).toEqual([]);
    });
});

describe(`presence reporter`, () => {
    beforeEach(() => {
        vi.useFakeTimers();
        requestMock.mockClear();
    });
    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        resetPresence();
    });

    it(`debounces a burst into one report and dedupes an unchanged one`, async () => {
        presenceStreamOpened(`conn-1`);
        await vi.runAllTimersAsync();
        requestMock.mockClear();
        reportView(`workspace`);
        reportOpenPath(`src/app.ts`);
        await vi.runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        const [path, init] = requestMock.mock.calls[0]!;
        expect(path).toBe(`/system/presence`);
        expect(JSON.parse(init?.body as string)).toMatchObject({ clientId: `conn-1`, view: `workspace`, path: `src/app.ts` });
        // Same state again → deduped, no second POST.
        reportView(`workspace`);
        await vi.runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it(`re-announces on a new connection id even when the state is unchanged`, async () => {
        presenceStreamOpened(`conn-2`);
        await vi.runAllTimersAsync();
        const bodies = requestMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string) as { clientId: string });
        expect(bodies.at(-1)?.clientId).toBe(`conn-2`);
        requestMock.mockClear();
        // The reconnect: same activity, fresh connection — must re-send under the new id.
        presenceStreamOpened(`conn-3`);
        await vi.runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(requestMock.mock.calls[0]![1]?.body as string)).toMatchObject({ clientId: `conn-3` });
    });

    it(`self-heals when its own roster entry arrives blank (report raced the registration)`, async () => {
        presenceStreamOpened(`conn-4`);
        reportView(`workspace`);
        await vi.runAllTimersAsync();
        requestMock.mockClear();
        // The daemon's snapshot shows OUR connection with no view — the report was dropped; expect a re-send.
        setPresenceUsers([tab({ clientId: `conn-4`, email: `me@x.com` })]);
        await vi.runAllTimersAsync();
        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(requestMock.mock.calls[0]![1]?.body as string)).toMatchObject({ clientId: `conn-4`, view: `workspace` });
    });
});
