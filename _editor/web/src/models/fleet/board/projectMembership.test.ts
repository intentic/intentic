import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { agentInProject, heldWakeInProject, roleInProject, runInProject } from "./projectMembership";

// Only the fields membership reads; the rest of a card is the role editor's business.
const role = (id: string, over: Partial<Role> = {}): Role => ({ id, ...over }) as Role;

describe(`which conversations a project shows`, () => {
    it(`files a conversation under the project it opened in, and under a parent project too`, () => {
        expect(agentInProject({ startIn: `shop` }, `shop`, [])).toBe(true);
        expect(agentInProject({ startIn: `shop/docs` }, `shop`, [])).toBe(true);
        expect(agentInProject({ startIn: `shop2` }, `shop`, [])).toBe(false);
        expect(agentInProject({ startIn: `` }, `shop`, [])).toBe(false);
    });

    it(`follows the role it acts as: its start folder or a carried repository`, () => {
        const cards = [role(`writer`, { workspace: { startIn: `shop/content` } }), role(`ops`, { context: { repos: [`shop`, `api`] } })];
        expect(agentInProject({ actsAs: `writer` }, `shop`, cards)).toBe(true);
        expect(agentInProject({ actsAs: `ops` }, `api`, cards)).toBe(true);
        expect(agentInProject({ actsAs: `ops` }, `docs`, cards)).toBe(false);
    });

    it(`leaves a root-started conversation with no role, or an unknown role, to All projects`, () => {
        expect(agentInProject({}, `shop`, [])).toBe(false);
        expect(agentInProject({ actsAs: `gone` }, `shop`, [])).toBe(false);
        expect(agentInProject({ actsAs: `blank` }, `shop`, [role(`blank`)])).toBe(false);
    });

    it(`counts a repository around the project as reaching it, since it carries the project`, () => {
        expect(roleInProject(role(`apps`, { context: { repos: [`apps`] } }), `apps/web`)).toBe(true);
    });
});

describe(`which held wakes a project shows`, () => {
    const cards = [role(`writer`, { workspace: { startIn: `shop/content` } })];
    const fleet = [
        { id: `thread-1`, startIn: `shop` },
        { id: `thread-2`, startIn: `api` },
    ];

    it(`follows the thread it would continue`, () => {
        expect(heldWakeInProject({ conversationId: `thread-1` }, `shop`, cards, fleet)).toBe(true);
        expect(heldWakeInProject({ conversationId: `thread-2` }, `shop`, cards, fleet)).toBe(false);
    });

    it(`follows the role it would speak as when it has no thread on the board`, () => {
        expect(heldWakeInProject({ actsAs: `writer` }, `shop`, cards, fleet)).toBe(true);
        expect(heldWakeInProject({ conversationId: `gone`, actsAs: `writer` }, `shop`, cards, fleet)).toBe(true);
        expect(heldWakeInProject({ actsAs: `writer` }, `api`, cards, fleet)).toBe(false);
    });

    it(`leaves a wake with neither under All projects`, () => {
        expect(heldWakeInProject({}, `shop`, cards, fleet)).toBe(false);
    });
});

describe(`which runs a project shows`, () => {
    it(`follows any step that opened in the project, and hides a run whose steps have not opened`, () => {
        const fleet = [
            { id: `s1`, startIn: `api`, workflow: { runId: `r1`, name: `Ship`, step: `Review`, index: 1, total: 2 } },
            { id: `s2`, startIn: `shop`, workflow: { runId: `r1`, name: `Ship`, step: `Test`, index: 2, total: 2 } },
        ];
        expect(runInProject({ runId: `r1` }, `shop`, [], fleet)).toBe(true);
        expect(runInProject({ runId: `r1` }, `docs`, [], fleet)).toBe(false);
        expect(runInProject({ runId: `r2` }, `shop`, [], fleet)).toBe(false);
    });
});
