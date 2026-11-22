import { t } from "@intentic/ui/i18n";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Stop everything and a workflow's own Stop (familyStop.ts): which cards offer it, what the press asks of the daemon, and
// what its receipt says was stopped.

const stopFamily = jest.fn(async (_input: { readonly id: string; readonly run?: string }) => ({ turn: false, runs: 1, agents: 3 }));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agents: { stopFamily } }) }));
const receipts: string[] = [];
jest.mock("../../../workbench/operations/operations", () => ({
    startOperation: async (_key: string, options: { readonly task: () => Promise<never>; readonly done: (value: never) => string }) => {
        receipts.push(options.done(await options.task()));
        return undefined;
    },
}));

const { familyGoing, pressStopFamily } = await import("./familyStop");

const RUN = { id: `wfr-1`, name: `spaces-materialize`, calls: 13, working: 3, failed: 2, startedAt: 1 };

beforeEach(() => {
    stopFamily.mockClear();
    receipts.length = 0;
});

it(`counts a card as going while a workflow run is live or a subagent works, and not for agents that only settled`, () => {
    expect(familyGoing({ scriptRuns: [RUN] })).toBe(true);
    expect(familyGoing({ subagents: { running: 2, total: 9 } })).toBe(true);
    expect(familyGoing({ subagents: { running: 0, total: 9 } })).toBe(false);
    expect(familyGoing({})).toBe(false);
});

it(`stops one run by its id, or everything with none, and says in its receipt what stopped`, async () => {
    pressStopFamily({ id: `syrup`, title: `Plan the port` }, RUN);
    pressStopFamily({ id: `syrup`, title: `Plan the port` });
    await new Promise((settle) => setTimeout(settle, 0));

    expect(stopFamily.mock.calls.map(([input]) => input)).toEqual([
        { id: `syrup`, run: `wfr-1` },
        { id: `syrup`, run: undefined },
    ]);
    const what = `${t(`agents.familyStop.agents`, { count: 3 }, 3)}, ${t(`agents.familyStop.runs`, { count: 1 }, 1)}`;
    expect(receipts).toEqual([t(`agents.familyStop.stopped`, { what }), t(`agents.familyStop.stopped`, { what })]);
});
