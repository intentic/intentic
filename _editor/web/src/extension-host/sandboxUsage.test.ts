import { beforeEach, expect, test, vi } from "vitest";

const sandboxJson = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock(`../composables/sandbox/sandboxClient`, () => ({ sandboxJson }));

const { flushSandboxUsage, recordSandboxCall } = await import(`./sandboxUsage`);

/* The ledger's job is to turn concrete calls back into the manifest lines that permitted them, and to lose
 * nothing on the way to the daemon. Both are properties nobody would notice breaking: a miscounted route reads
 * exactly like an unused one. */

const PERMISSIONS = [`GET /panels`, `POST /panels/*/start`, `GET /workspace/file`];

beforeEach(async () => {
    sandboxJson.mockClear();
    sandboxJson.mockImplementation(async () => ({ ok: true }));
    await flushSandboxUsage();
    sandboxJson.mockClear();
});

test(`counts against the declared entry, not the path that was called`, async () => {
    // The point of the whole design: a wildcard entry and a query string collapse onto the manifest line an
    // author would delete. Counting concrete paths would make the figures unbounded AND make them a record of
    // what the owner was doing rather than of what the extension needs.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `POST`, `/panels/my-app/start`);
    recordSandboxCall(`repo-apps`, PERMISSIONS, `POST`, `/panels/other-app/start`);
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/workspace/file?path=src/main.ts`);

    await flushSandboxUsage();

    expect(sandboxJson).toHaveBeenCalledTimes(1);
    const [path, init] = sandboxJson.mock.calls[0] as unknown as [string, { body: string }];
    expect(path).toBe(`/extensions/repo-apps/usage`);
    expect(JSON.parse(init.body)).toEqual({ used: { "POST /panels/*/start": 2, "GET /workspace/file": 1 } });
});

test(`keeps the counts when the daemon is unreachable`, async () => {
    sandboxJson.mockImplementationOnce(async () => {
        throw new Error(`offline`);
    });
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/panels`);
    await flushSandboxUsage();

    // Re-queued, not lost: this measures whether a permission is used at all, and a minute of downtime must not
    // read afterwards as a minute of the extension not needing it.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/panels`);
    await flushSandboxUsage();

    const [, init] = sandboxJson.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ used: { "GET /panels": 2 } });
});

test(`reports nothing at all when nothing was called`, async () => {
    await flushSandboxUsage();
    expect(sandboxJson).not.toHaveBeenCalled();
});

test(`ignores a call no declared entry covers`, async () => {
    // Unreachable through the gate, which throws first, so this only happens if the two matchers ever disagree,
    // and an unattributable call is worse than no call: it would credit a permission that did not permit it.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `DELETE`, `/panels`);
    await flushSandboxUsage();
    expect(sandboxJson).not.toHaveBeenCalled();
});
