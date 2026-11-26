import type { WorkspaceGraph } from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { unstubbed } from "@intentic/testing";
import { type BackendReader, backendRead } from "./backendRead";

// A refusal the daemon answered, as the host throws it: an error carrying the HTTP status.
class Answered extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

// What either door answers in these tests: a graph, or a throw.
type Door = (path: string) => Promise<WorkspaceGraph>;

interface Reader {
    readonly api: BackendReader;
    // Each call, in order, as `<door> <path>`.
    readonly asked: string[];
}

// The two doors a read goes through: this extension's backend, and the daemon's own routes as the manifest grants them.
const reader = (backend: Door, sandbox: Door): Reader => {
    const asked: string[] = [];
    const api: BackendReader = {
        backend: unstubbed<BackendReader[`backend`]>(`backend`, {
            json: async <T>(path: string): Promise<T> => {
                asked.push(`backend ${path}`);
                // SAFETY: the test's answer stands in for whatever the backend would have parsed to.
                return (await backend(path)) as T;
            },
        }),
        sandbox: unstubbed<BackendReader[`sandbox`]>(`sandbox`, {
            json: async <T>(path: string): Promise<T> => {
                asked.push(`daemon ${path}`);
                // SAFETY: as above, for the daemon's own route.
                return (await sandbox(path)) as T;
            },
        }),
    };
    return { api, asked };
};

const refusedBeforeSending = async (): Promise<never> => {
    throw new Error(`extension "intentic.repo-apps" called undeclared sandbox route GET /workspace/repos/shop/graph`);
};

test(`the backend's answer is the answer, and the daemon's old route is never asked`, async () => {
    const { api, asked } = reader(async () => ({ packages: [], edges: [] }), refusedBeforeSending);
    expect(await backendRead(api, `graph?repo=shop`, `/workspace/repos/shop/graph`)).toEqual({ packages: [], edges: [] });
    expect(asked).toEqual([`backend graph?repo=shop`]);
});

test(`a daemon with no backend for this extension is asked at its own route, whether its host is up or not`, async () => {
    for (const status of [404, 503]) {
        const { api, asked } = reader(
            async () => {
                throw new Answered(status, `no backend for extension "intentic.repo-apps"`);
            },
            async () => ({ packages: [{ name: `@s/web`, dir: `apps/web`, group: `apps` }], edges: [] }),
        );
        expect(await backendRead(api, `graph?repo=shop`, `/workspace/repos/shop/graph`)).toEqual({
            packages: [{ name: `@s/web`, dir: `apps/web`, group: `apps` }],
            edges: [],
        });
        expect(asked).toEqual([`backend graph?repo=shop`, `daemon /workspace/repos/shop/graph`]);
    }
});

test(`the backend's own refusal stands when this daemon no longer grants the old route`, async () => {
    const missing = new Answered(404, `no workspace package "@s/nope" in shop`);
    const { api } = reader(async () => {
        throw missing;
    }, refusedBeforeSending);
    await expect(backendRead(api, `layers?repo=shop&package=%40s%2Fnope`, `/workspace/repos/shop/layers?package=%40s%2Fnope`)).rejects.toBe(missing);
});

test(`an older daemon's own refusal is what it said`, async () => {
    const fenced = new Answered(403, `outside your access to this workspace`);
    const { api } = reader(
        async () => {
            throw new Answered(404, `no backend for extension "intentic.repo-apps"`);
        },
        async () => {
            throw fenced;
        },
    );
    await expect(backendRead(api, `graph?repo=shop`, `/workspace/repos/shop/graph`)).rejects.toBe(fenced);
});

test(`a backend that failed for any other reason is not asked around`, async () => {
    const broken = new Answered(500, `ENOENT`);
    const { api, asked } = reader(async () => {
        throw broken;
    }, refusedBeforeSending);
    await expect(backendRead(api, `graph?repo=shop`, `/workspace/repos/shop/graph`)).rejects.toBe(broken);
    expect(asked).toEqual([`backend graph?repo=shop`]);
});
