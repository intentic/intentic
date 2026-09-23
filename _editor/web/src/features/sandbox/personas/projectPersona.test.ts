import { type Persona, PersonaSchema } from "@intentic/sandbox-contract";
import { describe, it, expect, afterEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { rpcKey } from "../../../lib/queryKeys";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { ProcedureInput } from "../client/sandboxRpc";

// Every daemon call the module made, in order, and what the fake daemon answers to the list read.
const calls = hoisted(() => ({
    made: [] as { procedure: string; input?: unknown }[],
    listed: [] as Persona[],
}));
const list = mock(async () => {
    calls.made.push({ procedure: `personas.list` });
    return { personas: calls.listed, connected: [] };
});
const save = mock(async (persona: ProcedureInput<`personas.save`>) => {
    calls.made.push({ procedure: `personas.save`, input: persona });
    return { ok: true as const };
});
const invalidateQueries = mock(async () => undefined);
mock.module("../../../lib/queryPersistence", () => ({ queryClient: { invalidateQueries } }));
mock.module("../client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ personas: { list, save } }) }));

const { ensureProjectPersona, projectPersonaPersona, projectPersonaId } = await import("./projectPersona");

afterEach(() => {
    calls.made = [];
    calls.listed = [];
    invalidateQueries.mockClear();
});

describe(`the project's own persona`, () => {
    it(`has an id the daemon accepts whatever the folder is called, and is fenced to the project`, () => {
        expect(projectPersonaId(`web`)).toBe(`project-web`);
        expect(projectPersonaId(`tools/cli.v2`)).toBe(`project-tools-cli-v2`);
        const persona = projectPersonaPersona(`tools/cli`);
        expect(PersonaSchema.safeParse(persona).success).toBe(true);
        expect(persona).toMatchObject({
            label: `cli`,
            workspace: { startIn: `tools/cli`, folders: [`tools/cli`] },
            context: { repos: [`tools/cli`] },
        });
    });

    it(`is written once, the first time it is needed`, async () => {
        expect(await ensureProjectPersona(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.procedure)).toEqual([`personas.list`, `personas.save`]);
        expect(calls.made[1]?.input).toEqual(projectPersonaPersona(`web`));
        // The list every picker reads, so the new persona shows up without a reload.
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: rpcKey(`personas.list`) });
    });

    it(`leaves an existing persona alone, so the owner's edits to it survive`, async () => {
        calls.listed = [{ id: `project-web`, capabilities: [] }];
        expect(await ensureProjectPersona(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.procedure)).toEqual([`personas.list`]);
        expect(invalidateQueries).toHaveBeenCalledTimes(0);
    });
});
