import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { activate } from "./extension";
import { bindHost } from "./host";
import { runningOf, workflowRunsQuery } from "./runsQuery";

// Only `state` is populated; a full workflow graph per row would be testing the schema, not this.
const run = (state: WorkflowRun[`state`]): WorkflowRun => ({ state }) as WorkflowRun;

const fakeHost = (runs: WorkflowRun[]) => {
    const procedures: string[] = [];
    const views: ViewRegistration[] = [];
    const fetched: HostQuery[] = [];
    const api = {
        sandbox: {
            readKey: (procedure: string, input?: unknown) => [procedure, ...(input === undefined ? [] : [input]), `box`],
            reachable: () => true,
            rpc: {
                workflows: {
                    runs: async () => {
                        procedures.push(`workflows.runs`);
                        return { runs };
                    },
                },
            },
            // Returns the entry directly rather than running queryFn, so callers can hand it minimal run fixtures.
            fetch: async <T>(query: HostQuery<T>): Promise<T> => {
                fetched.push(query);
                return { runs } as unknown as T;
            },
        },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => undefined };
            },
        },
    } as unknown as IntenticApi;
    return { api, procedures, views, fetched };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    jest.restoreAllMocks();
});

const tile: Activation = { key: `workflows`, title: `Workflows` };

describe(`the run ledger`, () => {
    it(`uses the shell's own entry for the read, which the daemon's file push refreshes`, async () => {
        const { api, procedures } = fakeHost([]);
        bindHost(api);

        const query = workflowRunsQuery();
        expect(query.queryKey).toEqual([`workflows.runs`, `box`]);
        await expect(query.queryFn()).resolves.toEqual({ runs: [] });
        expect(procedures).toEqual([`workflows.runs`]);
    });

    it(`counts what is happening now and nothing that has already ended`, () => {
        expect(runningOf([run(`running`), run(`done`), run(`failed`), run(`stopped`), run(`overspent`), run(`error`), run(`running`)])).toBe(2);
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
        // The running channel, not a count chip: a fan-out in flight is not an errand, and it still seats the tile.
        // Nothing else may be set, or the rail would draw a plate for it beside the mark.
        await waitFor(() => expect(registered?.badge?.(tile)).toEqual({ running: `1 running` }));
        expect(fetched[0]).toMatchObject({ queryKey: [`workflows.runs`, `box`] });
        expect(registered?.warm?.()[0]).toMatchObject({ queryKey: [`workflows.runs`, `box`] });
    });

    it(`stands down once the last run ends, rather than counting history for ever`, async () => {
        const { api, views } = fakeHost([run(`failed`), run(`done`)]);
        bindHost(api);

        activate(api, { extensionId: `ext-workflows`, subscriptions });

        await waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
