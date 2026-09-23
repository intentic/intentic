import type { Persona } from "@intentic/sandbox-contract";
import { agentInProject, heldWakeInProject, personaInProject, runInProject } from "./projectMembership";

// Only the fields membership reads; the rest of a card is the persona editor's business.
const persona = (id: string, over: Partial<Persona> = {}): Persona => ({ id, ...over }) as Persona;

describe(`which conversations a project shows`, () => {
    it(`files a conversation under the project it opened in, and under a parent project too`, () => {
        expect(agentInProject({ startIn: `shop` }, `shop`, [])).toBe(true);
        expect(agentInProject({ startIn: `shop/docs` }, `shop`, [])).toBe(true);
        expect(agentInProject({ startIn: `shop2` }, `shop`, [])).toBe(false);
        expect(agentInProject({ startIn: `` }, `shop`, [])).toBe(false);
    });

    it(`follows the persona it acts as: its start folder, a carried repository, or a fenced folder`, () => {
        const cards = [
            persona(`writer`, { workspace: { startIn: `shop/content` } }),
            persona(`ops`, { context: { repos: [`shop`, `api`] } }),
            persona(`fenced`, { workspace: { folders: [`shop/src`] } }),
            persona(`wide`, { workspace: { folders: [`.`] } }),
        ];
        expect(agentInProject({ actsAs: `writer` }, `shop`, cards)).toBe(true);
        expect(agentInProject({ actsAs: `ops` }, `api`, cards)).toBe(true);
        expect(agentInProject({ actsAs: `fenced` }, `shop`, cards)).toBe(true);
        expect(agentInProject({ actsAs: `wide` }, `shop`, cards)).toBe(false);
    });

    it(`leaves a root-started conversation with no persona, or an unknown persona, to All projects`, () => {
        expect(agentInProject({}, `shop`, [])).toBe(false);
        expect(agentInProject({ actsAs: `gone` }, `shop`, [])).toBe(false);
        expect(agentInProject({ actsAs: `blank` }, `shop`, [persona(`blank`)])).toBe(false);
    });

    it(`counts a folder around the project as reaching it, since its file tools may touch the project`, () => {
        expect(personaInProject(persona(`apps`, { workspace: { folders: [`apps`] } }), `apps/web`)).toBe(true);
    });
});

describe(`which held wakes a project shows`, () => {
    const cards = [persona(`writer`, { workspace: { startIn: `shop/content` } })];
    const fleet = [
        { id: `thread-1`, startIn: `shop` },
        { id: `thread-2`, startIn: `api` },
    ];

    it(`follows the thread it would continue`, () => {
        expect(heldWakeInProject({ conversationId: `thread-1` }, `shop`, cards, fleet)).toBe(true);
        expect(heldWakeInProject({ conversationId: `thread-2` }, `shop`, cards, fleet)).toBe(false);
    });

    it(`follows the persona it would speak as when it has no thread on the board`, () => {
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
