import type { CiRunsResponse } from "@intentic/sandbox-contract/schemas/ci";
import { unstubbed } from "@intentic/testing";
import { type BackendCaller, backendCall, posting } from "./backendCall";

// A refusal the daemon answered, as the host throws it: an error carrying the HTTP status.
class Answered extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

// What either door answers in these tests: the board's runs, or a throw.
type Door = (path: string, init?: RequestInit) => Promise<CiRunsResponse>;

interface Reader {
    readonly api: BackendCaller;
    // Each call, in order, as `<door> <path>`.
    readonly asked: string[];
}

// The two doors a read goes through: this extension's backend, and the daemon's own routes as the manifest grants them.
const reader = (backend: Door, sandbox: Door): Reader => {
    const asked: string[] = [];
    const api: BackendCaller = {
        backend: unstubbed<BackendCaller[`backend`]>(`backend`, {
            json: async <T>(path: string, init?: RequestInit): Promise<T> => {
                asked.push(`backend ${init?.method ?? `GET`} ${path}`);
                // SAFETY: the test's answer stands in for whatever the backend would have parsed to.
                return (await backend(path, init)) as T;
            },
        }),
        sandbox: unstubbed<BackendCaller[`sandbox`]>(`sandbox`, {
            json: async <T>(path: string, init?: RequestInit): Promise<T> => {
                asked.push(`daemon ${init?.method ?? `GET`} ${path} ${String(init?.body ?? ``)}`.trimEnd());
                // SAFETY: as above, for the daemon's own route.
                return (await sandbox(path, init)) as T;
            },
        }),
    };
    return { api, asked };
};

const refusedBeforeSending = async (): Promise<never> => {
    throw new Error(`extension "intentic.pipelines" called undeclared sandbox route GET /ci/runs`);
};

test(`the backend's answer is the answer, and the daemon's old route is never asked`, async () => {
    const { api, asked } = reader(async () => ({ repos: [], runs: [], failures: [], ownerSteps: [] }), refusedBeforeSending);
    expect(await backendCall(api, `runs`, () => api.sandbox.json(`/ci/runs`))).toEqual({ repos: [], runs: [], failures: [], ownerSteps: [] });
    expect(asked).toEqual([`backend GET runs`]);
});

test(`a daemon with no backend for this extension is asked at its own route, whether its host is up or not`, async () => {
    for (const status of [404, 503]) {
        const { api, asked } = reader(
            async () => {
                throw new Answered(status, `no backend for extension "intentic.pipelines"`);
            },
            async () => ({ repos: [], runs: [], failures: [] }),
        );
        expect(await backendCall(api, `runs`, () => api.sandbox.json(`/ci/runs`))).toEqual({ repos: [], runs: [], failures: [] });
        expect(asked).toEqual([`backend GET runs`, `daemon GET /ci/runs`]);
    }
});

test(`the backend's own refusal stands when this daemon no longer grants the old route`, async () => {
    const missing = new Answered(404, `no CI project mapped for repo "shop"`);
    const { api } = reader(async () => {
        throw missing;
    }, refusedBeforeSending);
    await expect(backendCall(api, `fix`, () => api.sandbox.json(`/ci/fix`, posting({ repo: `shop`, runId: 7 })), posting({ repo: `shop`, runId: 7 }))).rejects.toBe(missing);
});

test(`an older daemon's own refusal is what it said`, async () => {
    const fenced = new Answered(403, `outside your access to this workspace`);
    const { api } = reader(
        async () => {
            throw new Answered(404, `no backend for extension "intentic.pipelines"`);
        },
        async () => {
            throw fenced;
        },
    );
    await expect(backendCall(api, `runs`, () => api.sandbox.json(`/ci/runs`))).rejects.toBe(fenced);
});

test(`a backend that failed for any other reason is not asked around`, async () => {
    const broken = new Answered(500, `ENOENT`);
    const { api, asked } = reader(async () => {
        throw broken;
    }, refusedBeforeSending);
    await expect(backendCall(api, `runs`, () => api.sandbox.json(`/ci/runs`))).rejects.toBe(broken);
    expect(asked).toEqual([`backend GET runs`]);
});

// 2026-11-26: a Fix pressed on a board driving a sandbox whose image predates the backend goes to that daemon's own route,
// with the same body, and is answered there.
test(`a press against an older daemon is made at its own route, with the same body`, async () => {
    const { api, asked } = reader(
        async () => {
            throw new Answered(404, `no backend for extension "intentic.pipelines"`);
        },
        async () => ({ repos: [], runs: [] }),
    );
    await backendCall(api, `fix`, () => api.sandbox.json(`/ci/fix`, posting({ repo: `web`, runId: 41 })), posting({ repo: `web`, runId: 41 }));
    expect(asked).toEqual([`backend POST fix`, `daemon POST /ci/fix {"repo":"web","runId":41}`]);
});
