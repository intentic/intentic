import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "./extension";
import { bindHost } from "./host";
import { runningOf, workflowRunsQuery } from "./runsQuery";

// Only the run's state is read here, so the rest of the ledger's shape is deliberately not built out: a fixture
// carrying a whole workflow graph per row would be testing the schema, which has its own tests.
const run = (state: WorkflowRun[`state`]): WorkflowRun => ({ state }) as WorkflowRun;

const fakeHost = (runs: WorkflowRun[]) => {
    const paths: string[] = [];
    const views: ViewRegistration[] = [];
    const fetched: HostQuery[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                paths.push(path);
                return { runs };
            },
            // Answers the ENTRY rather than running its queryFn, so the badge cases above can hand it two-field
            // runs: the parse is the first test's subject, and a fixture carrying a whole graph per row to get
            // past it would be a schema test wearing a badge test's name.
            fetch: async <T>(query: HostQuery<T>): Promise<T> => {
                fetched.push(query);
                return runs as unknown as T;
            },
        },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => undefined };
            },
        },
    } as unknown as IntenticApi;
    return { api, paths, views, fetched };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    vi.restoreAllMocks();
});

const tile: Activation = { key: `workflows`, title: `Workflows` };

describe(`the run ledger`, () => {
    it(`uses the entry the daemon's own file push already invalidates`, async () => {
        const { api, paths } = fakeHost([]);
        bindHost(api);

        const query = workflowRunsQuery();
        expect(query.queryKey).toEqual([`sandbox`, `box`, `workflow-runs`]);
        await expect(query.queryFn()).resolves.toEqual([]);
        expect(paths).toEqual([`/workflows/runs`]);
    });

    it(`counts what is happening now and nothing that has already ended`, () => {
        expect(runningOf([run(`running`), run(`done`), run(`failed`), run(`stopped`), run(`overspent`), run(`error`), run(`running`)])).toBe(2);
        // The state this tile spends most of its life in: every design saved, nothing in flight, nothing to say.
        expect(runningOf([run(`done`), run(`failed`)])).toBe(0);
    });
});

describe(`the Workflows tile`, () => {
    it(`badges a fan-out in flight, which is what puts it on the rail while one is working`, async () => {
        const { api, views, fetched } = fakeHost([run(`running`), run(`done`)]);
        bindHost(api);
        const context: ExtensionContext = { extensionId: `ext-workflows`, subscriptions };

        activate(api, context);

        const registered = views[0];
        expect(registered?.id).toBe(`workflows`);
        await vi.waitFor(() => expect(registered?.badge?.(tile)).toBeDefined());
        // `neutral`: a run working is an inventory, not a debt. It seats the tile without asking to be cleared.
        expect(registered?.badge?.(tile)).toMatchObject({ count: 1, tone: `neutral`, tooltip: `1 running` });
        // The badge and the page read ONE entry: the poll fills what the view then paints from.
        expect(fetched[0]).toMatchObject({ queryKey: [`sandbox`, `box`, `workflow-runs`] });
        expect(registered?.warm?.()[0]).toMatchObject({ queryKey: [`sandbox`, `box`, `workflow-runs`] });
    });

    it(`stands down once the last run ends, rather than counting history for ever`, async () => {
        const { api, views } = fakeHost([run(`failed`), run(`done`)]);
        bindHost(api);

        activate(api, { extensionId: `ext-workflows`, subscriptions });

        await vi.waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
