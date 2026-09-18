// @vitest-environment jsdom
// jsdom: the import chain reaches app-wide singletons that read browser globals (window.env) as they load.
import { expect, it, vi } from "vitest";

// What a connection read learns about accounts the provider is holding reads off. A press was the only thing that ever
// asked, so a frozen number explained itself only to whoever pressed the control it had already stopped answering —
// and on arrival, the surface most likely to be read, the one line that says why said nothing at all.

vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));

const { sandboxJson } = await import("../../sandbox/client/sandboxClient");

interface Posted {
    readonly path: string;
    readonly force: unknown;
}

// Answers every list empty and records what the plan-limits route was asked for; `held` is what it answers with.
const daemon = (held: unknown, posted: Posted[] = []): Posted[] => {
    vi.mocked(sandboxJson).mockImplementation((path: string, init?: RequestInit) => {
        if (path === `/usage/plan-limits/refresh`) {
            posted.push({ path, force: JSON.parse(String(init?.body ?? `{}`)).force });
            return Promise.resolve(held === undefined ? Promise.reject(new Error(`daemon is unreachable`)) : { ok: true, held });
        }
        return Promise.resolve(path === `/translator/accounts` ? { codex: [], grok: [], kimi: [], gemini: [] } : { accounts: [] });
    });
    return posted;
};

const { heldAccounts, refreshConnections } = await import("./useChat-accounts");

const HELD = [{ provider: `claude`, account: `a`, resumesAt: 1_800_000_000 }];

it(`learns what is held on arrival, not only from a press`, async () => {
    const posted = daemon(HELD);
    heldAccounts.value = [];

    await refreshConnections();
    // Unforced: the sweep it triggers is held to every target's own read budget, so arriving at a screen cannot
    // itself spend the endpoint budget the number depends on.
    expect(posted).toEqual([{ path: `/usage/plan-limits/refresh`, force: false }]);
    expect(heldAccounts.value).toEqual(HELD);
});

it(`asks to measure again when a press says so, and takes the answer over the one it had`, async () => {
    const posted = daemon([]);
    heldAccounts.value = HELD;

    await refreshConnections(true);
    expect(posted).toEqual([{ path: `/usage/plan-limits/refresh`, force: true }]);
    // A press that read everything says so by answering with nothing held; the note has to come down.
    expect(heldAccounts.value).toEqual([]);
});

it(`keeps what it last knew when the daemon does not answer, since silence withdraws nothing`, async () => {
    daemon(undefined);
    heldAccounts.value = HELD;

    await refreshConnections(true);
    expect(heldAccounts.value).toEqual(HELD);
});
