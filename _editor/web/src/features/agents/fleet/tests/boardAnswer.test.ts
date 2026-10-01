import { resetSandboxScope } from "@intentic/extension-api";
import type { SandboxRpc } from "../../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// A permission answered on the board card: what it may answer, what it sends, and that the card reads answered from the
// press and asks again when the sandbox did not take it.

// The daemon's reply route, the only call an answer makes.
const { replyRoute } = { replyRoute: jest.fn<SandboxRpc["agent"]["reply"]>(async () => ({ ok: true as const })) };

// The fleet store pulls the app shell at import time; the same cuts as useAgents-provisional.test.ts.
jest.mock("../../../../router/index", () => ({ router: { push: jest.fn() } }));
jest.mock("../../../../app/analytics", () => ({ track: jest.fn() }));
jest.mock("../../../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
}));
jest.mock("../../../sandbox/overview/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`] }));
jest.mock("../../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { reply: replyRoute } }) }));
jest.mock("../../../sandbox/client/sandboxClient", () => ({ sandboxJson: jest.fn(), sandboxRequest: jest.fn() }));
jest.mock("../../../../app/clientDiagnostics", () => ({ reportClient: jest.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { SKIP_CALL } from "../../../chat/session/cardReplies";
import { answerableAsk, answerFromBoard, boardReply } from "../boardAnswer";
import { useAgents } from "../useAgents";
import { setAgents } from "../useAgents-registry";

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const ASK = { requestId: `perm-1`, ask: "Run `pnpm build`?" };
const asking = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    id: `c1`,
    status: `awaiting`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: { ...none, permission: true },
    permissionAsk: ASK,
    ...over,
});

let rev = 0;
const roster = (...agents: AgentSummary[]): void => setAgents(agents, (rev += 1));
const shown = () => useAgents().fleet.value.find((agent) => agent.id === `c1`);

beforeEach(() => {
    resetSandboxScope();
    rev = 0;
    replyRoute.mockReset();
});

describe("what a card may answer", () => {
    test("the permission its turn waits on, while the flag stands on a live card", () => {
        expect(answerableAsk(asking())).toEqual(ASK);
    });

    // A sandbox older than the field raises the flag alone: the drill-in to the chat stays the one way.
    test("nothing without the ask, the flag, or once archived", () => {
        expect(answerableAsk(asking({ permissionAsk: undefined }))).toBeUndefined();
        expect(answerableAsk(asking({ attention: none }))).toBeUndefined();
        expect(answerableAsk(asking({ archivedAt: 5_000 }))).toBeUndefined();
    });
});

describe("what an answer sends", () => {
    test("allow once is this call alone; skip refuses it and tells the agent to carry on, as the chat's skip does", () => {
        expect(boardReply(ASK, `once`)).toEqual({ kind: `permission`, requestId: `perm-1`, decision: `once` });
        expect(boardReply(ASK, `skip`)).toEqual({ ...SKIP_CALL, requestId: `perm-1` });
    });
});

describe("answering from the board", () => {
    test("reads answered from the press, and says the sandbox took it", async () => {
        roster(asking());
        let take: (() => void) | undefined;
        replyRoute.mockImplementation(() => new Promise((resolve) => (take = () => resolve({ ok: true }))));
        const answered = answerFromBoard({ id: `c1` }, ASK, `once`);
        expect(shown()?.attention.permission).toBe(false);
        expect(shown()?.status).toBe(`running`);
        take?.();
        expect(await answered).toBe(true);
        expect(replyRoute).toHaveBeenCalledWith({ kind: `permission`, requestId: `perm-1`, decision: `once` }, { context: { at: undefined } });
    });

    test("asks again when the sandbox did not take it", async () => {
        roster(asking());
        replyRoute.mockRejectedValue(new Error(`the turn ended`));
        expect(await answerFromBoard({ id: `c1` }, ASK, `skip`)).toBe(false);
        expect(shown()?.attention.permission).toBe(true);
        expect(shown()?.status).toBe(`awaiting`);
    });
});
