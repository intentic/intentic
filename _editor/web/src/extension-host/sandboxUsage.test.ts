import { test, expect, beforeEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../testing/sandboxRpcFake";

const recordUsage = hoisted(() => mock(async (_input: unknown) => ({ ok: true as const })));
mock.module(`../features/sandbox/client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ extensions: { recordUsage } }) }));

const { flushSandboxUsage, recordSandboxCall } = await import(`./sandboxUsage`);

// Ledger turns concrete calls back into the manifest lines that permitted them, and must lose none on the way to the
// daemon.
// Both properties fail silently: a miscounted route reads exactly like an unused one.

const PERMISSIONS = [`GET /panels`, `POST /panels/*/start`, `GET /workspace/file`];

beforeEach(async () => {
    recordUsage.mockClear();
    recordUsage.mockImplementation(async () => ({ ok: true as const }));
    await flushSandboxUsage();
    recordUsage.mockClear();
});

test(`counts against the declared entry, not the path that was called`, async () => {
    // Concrete paths (a wildcard entry, a query string) collapse onto the manifest line that permitted them.
    // Counting the raw path would be unbounded and record what the owner did, not what the extension needs.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `POST`, `/panels/my-app/start`);
    recordSandboxCall(`repo-apps`, PERMISSIONS, `POST`, `/panels/other-app/start`);
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/workspace/file?path=src/main.ts`);

    await flushSandboxUsage();

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]).toEqual([
        {
            reports: { "repo-apps": { "POST /panels/*/start": 2, "GET /workspace/file": 1 } },
        },
    ]);
});

test(`reports every extension in one request`, async () => {
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/panels`);
    recordSandboxCall(`deployments`, PERMISSIONS, `GET`, `/workspace/file?path=deployments.json`);

    await flushSandboxUsage();

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]).toEqual([
        {
            reports: {
                "repo-apps": { "GET /panels": 1 },
                deployments: { "GET /workspace/file": 1 },
            },
        },
    ]);
});

test(`keeps the counts when the daemon is unreachable`, async () => {
    recordUsage.mockImplementationOnce(async () => {
        throw new Error(`offline`);
    });
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/panels`);
    await flushSandboxUsage();

    // Re-queued, not lost: downtime must not read afterward as the extension not needing the permission.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `GET`, `/panels`);
    await flushSandboxUsage();

    expect(recordUsage.mock.calls[1]).toEqual([{ reports: { "repo-apps": { "GET /panels": 2 } } }]);
});

test(`reports nothing at all when nothing was called`, async () => {
    await flushSandboxUsage();
    expect(recordUsage).not.toHaveBeenCalled();
});

test(`ignores a call no declared entry covers`, async () => {
    // The gate throws first in practice; this guards against ever crediting an uncovered call.
    recordSandboxCall(`repo-apps`, PERMISSIONS, `DELETE`, `/panels`);
    await flushSandboxUsage();
    expect(recordUsage).not.toHaveBeenCalled();
});
