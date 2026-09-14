import { PersonaSchema } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/queryPersistence", () => ({ queryClient: { invalidateQueries: vi.fn(async () => undefined) } }));
vi.mock("../client/sandboxClient", () => ({
    sandboxJson: (path: string, init?: RequestInit) => calls.handle(path, init),
}));

// Every daemon call the module made, and what the fake daemon answers to the list read.
const calls = vi.hoisted(() => ({
    made: [] as { path: string; method: string; body?: unknown }[],
    listed: [] as { id: string; capabilities: string[] }[],
    handle(path: string, init?: RequestInit): Promise<unknown> {
        const method = init?.method ?? `GET`;
        calls.made.push({ path, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
        return Promise.resolve(method === `GET` ? { personas: calls.listed, connected: [] } : { ok: true });
    },
}));

const { ensureProjectPersona, projectPersonaCard, projectPersonaId } = await import("./projectPersona");

afterEach(() => {
    calls.made = [];
    calls.listed = [];
});

describe(`the project's own persona`, () => {
    it(`has an id the daemon accepts whatever the folder is called, and is fenced to the project`, () => {
        expect(projectPersonaId(`web`)).toBe(`project-web`);
        expect(projectPersonaId(`tools/cli.v2`)).toBe(`project-tools-cli-v2`);
        const card = projectPersonaCard(`tools/cli`);
        expect(PersonaSchema.safeParse(card).success).toBe(true);
        expect(card).toMatchObject({ label: `cli`, workspace: { startIn: `tools/cli`, folders: [`tools/cli`] }, context: { repos: [`tools/cli`] } });
    });

    it(`is written once, the first time it is needed`, async () => {
        expect(await ensureProjectPersona(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.method)).toEqual([`GET`, `POST`]);
        expect(calls.made[1]?.body).toEqual(projectPersonaCard(`web`));
    });

    it(`leaves an existing card alone, so the owner's edits to it survive`, async () => {
        calls.listed = [{ id: `project-web`, capabilities: [] }];
        expect(await ensureProjectPersona(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.method)).toEqual([`GET`]);
    });
});
