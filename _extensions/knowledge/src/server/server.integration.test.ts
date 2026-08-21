import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRouteHandler, ExtensionServerApi } from "@intentic/extension-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE, type Graph, type Note, type Overview } from "../contract.js";
import { activateServer } from "./server.js";

/* The backend as the daemon actually drives it: activateServer mounts one fetch handler, the host strips the
 * /x prefix, and everything below is real files on a real disk. Worth an integration test rather than unit
 * tests over the handlers, because what can break here is the WIRE: an output the contract's schema rejects,
 * a query parameter that never arrives, and none of that is visible from the inside. */

let workspace: string;
let handler: BackendRouteHandler;

const put = async (path: string, content: string): Promise<void> => {
    const full = join(workspace, `knowledge`, path);
    await mkdir(join(full, `..`), { recursive: true });
    await writeFile(full, content);
};

const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await handler(new Request(`http://sandbox${path}`, init));
    expect(response, `nothing served ${path}`).toBeDefined();
    return response!;
};

const json = async <T>(path: string): Promise<T> => {
    const response = await call(path);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
};

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), `kb-server-`));
    await put(`_vocabulary.md`, `---\ntype: vocabulary\ntypes: [person, project]\nrelations: [works_on]\n---\nWhat the words mean.`);
    await put(
        `person/ada-lovelace.md`,
        `---\ntype: person\ntitle: Ada Lovelace\naliases: [Ada]\ntags: [colleague]\nworks_on: ["[[Intentic]]"]\n---\nWrote the first program.`,
    );
    await put(`project/intentic.md`, `---\ntype: project\ntitle: Intentic\n---\nThe workspace. See [[nowhere]].`);
    const api = {
        apiVersion: `2.1.0`,
        workspaceRoot: workspace,
        extensionDir: `/opt/extensions/knowledge`,
        log: () => {},
        routes: {
            mount: (mounted: BackendRouteHandler) => {
                handler = mounted;
            },
        },
        daemon: { request: () => Promise.reject(new Error(`unused`)), json: () => Promise.reject(new Error(`unused`)) },
    } as unknown as ExtensionServerApi;
    activateServer(api, { extensionId: `intentic.knowledge` });
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe(`the knowledge backend`, () => {
    it(`answers nothing for a path outside its own namespace, so the host can 404 it`, async () => {
        expect(await handler(new Request(`http://sandbox/not-ours`))).toBeUndefined();
    });

    it(`lists every note with both link counts`, async () => {
        const { notes } = await json<{ notes: { path: string; title: string; linkCount: number; backlinkCount: number }[] }>(`/notes`);
        expect(notes.map((note) => note.path)).toEqual([`_vocabulary.md`, `person/ada-lovelace.md`, `project/intentic.md`]);
        expect(notes.find((note) => note.path === `project/intentic.md`)).toMatchObject({ title: `Intentic`, linkCount: 1, backlinkCount: 1 });
    });

    it(`serves one note with its facts and its connections resolved both ways`, async () => {
        const note = await json<Note>(`/note?path=${encodeURIComponent(`project/intentic.md`)}`);
        expect(note.summary.title).toBe(`Intentic`);
        expect(note.linkedFrom).toEqual([{ relation: `works_on`, path: `person/ada-lovelace.md`, title: `Ada Lovelace` }]);
        // A link to a note nobody has written keeps its name and has nowhere to go: the knowledge base's to-do list.
        expect(note.linksTo).toEqual([{ relation: undefined, path: undefined, title: `nowhere` }]);
    });

    it(`hands back the file exactly as it is on disk, so an edit can be saved without losing anything`, async () => {
        const note = await json<Note>(`/note?path=${encodeURIComponent(`person/ada-lovelace.md`)}`);
        expect(note.content).toBe(
            `---\ntype: person\ntitle: Ada Lovelace\naliases: [Ada]\ntags: [colleague]\nworks_on: ["[[Intentic]]"]\n---\nWrote the first program.`,
        );
    });

    it(`finds a note by anything that names it`, async () => {
        const byAlias = await json<{ hits: { path: string }[] }>(`/search?q=Ada`);
        expect(byAlias.hits[0]?.path).toBe(`person/ada-lovelace.md`);
        const byType = await json<{ hits: { path: string }[] }>(`/search?type=project`);
        expect(byType.hits.map((hit) => hit.path)).toEqual([`project/intentic.md`]);
    });

    it(`answers 404 for a note that is not there`, async () => {
        expect((await call(`/note?path=nope.md`)).status).toBe(404);
    });

    it(`draws the neighbourhood around a note`, async () => {
        const graph = await json<Graph>(`/graph?focus=Intentic&depth=1`);
        expect(graph.focus).toBe(`project/intentic.md`);
        expect(graph.nodes.map((node) => node.path).toSorted()).toEqual([`person/ada-lovelace.md`, `project/intentic.md`]);
        expect(graph.edges).toEqual([{ from: `person/ada-lovelace.md`, to: `project/intentic.md`, relation: `works_on` }]);
    });

    it(`reports what the knowledge base amounts to and what is unfinished about it`, async () => {
        const overview = await json<Overview>(`/overview`);
        expect(overview).toMatchObject({
            folder: `knowledge`,
            noteCount: 3,
            broken: [{ from: `project/intentic.md`, target: `nowhere` }],
            vocabulary: { types: [`person`, `project`], relations: [`works_on`], path: `_vocabulary.md` },
        });
        expect(overview.types).toEqual([
            { name: `person`, count: 1 },
            { name: `project`, count: 1 },
            { name: `vocabulary`, count: 1 },
        ]);
    });

    it(`saves a note and shows the change on the next read`, async () => {
        const saved = await call(`/note`, {
            method: `PUT`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: `person/ada-lovelace.md`, content: `---\ntype: person\n---\nCorrected.` }),
        });
        expect(saved.status).toBe(200);
        expect((await json<Note>(`/note?path=${encodeURIComponent(`person/ada-lovelace.md`)}`)).body).toBe(`Corrected.`);
    });

    it(`creates a note in a folder that does not exist yet`, async () => {
        const saved = await call(`/note`, {
            method: `PUT`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: `decision/why-extensions.md`, content: `---\ntype: decision\n---\nLean core.` }),
        });
        expect(saved.status).toBe(200);
        expect((await json<{ notes: { path: string }[] }>(`/notes`)).notes.map((note) => note.path)).toContain(`decision/why-extensions.md`);
    });

    // The route is reachable by anyone the daemon lets through; the knowledge base boundary is enforced here, not there.
    it(`refuses to write outside the knowledge base or as anything but a note`, async () => {
        for (const path of [`../escaped.md`, `run.sh`]) {
            const response = await call(`/note`, {
                method: `PUT`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ path, content: `x` }),
            });
            expect(response.status, path).toBe(400);
        }
    });

    it(`forgets a note, and says so only once`, async () => {
        const remove = (): Promise<Response> =>
            call(`/note`, {
                method: `DELETE`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ path: `person/ada-lovelace.md` }),
            });
        expect((await remove()).status).toBe(200);
        expect((await remove()).status).toBe(404);
    });

    it(`follows the knowledge base folder the owner chose`, async () => {
        await mkdir(join(workspace, `.intentic/config`), { recursive: true });
        await writeFile(
            join(workspace, `.intentic/config/extension-settings.json`),
            JSON.stringify({ "intentic.knowledge": { folder: `my-notes` } }),
        );
        await mkdir(join(workspace, `my-notes`), { recursive: true });
        await writeFile(join(workspace, `my-notes/only.md`), `---\ntype: term\n---\n`);
        const overview = await json<Overview>(`/overview`);
        expect(overview).toMatchObject({ folder: `my-notes`, noteCount: 1 });
    });

    /* Owner-pressed, never on a read: a knowledge base appearing in somebody's workspace because they looked at a panel
     * is a surprise, and one that overwrote a vocabulary they had written would be worse than a surprise. */
    it(`starts an empty knowledge base off with a vocabulary, and touches a started one never again`, async () => {
        await rm(join(workspace, `knowledge`), { recursive: true, force: true });
        const first = await call(`/seed`, { method: `POST` });
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ written: [`_vocabulary.md`] });

        const overview = await json<Overview>(`/overview`);
        expect(overview.noteCount).toBe(1);
        expect(overview.vocabulary.types).toContain(`person`);
        // The vocabulary explains the link syntax in a fenced example, which must not become real links, or a
        // brand-new knowledge base opens with a to-do list it invented about itself.
        expect(overview.broken).toEqual([]);

        const again = await call(`/seed`, { method: `POST` });
        expect(await again.json()).toEqual({ written: [] });
    });

    it(`leaves a knowledge base that already has a vocabulary alone`, async () => {
        expect(await (await call(`/seed`, { method: `POST` })).json()).toEqual({ written: [] });
        expect((await json<Note>(`/note?path=_vocabulary.md`)).body).toContain(`What the words mean.`);
    });

    it(`serves an empty knowledge base as empty rather than as an error`, async () => {
        await rm(join(workspace, `knowledge`), { recursive: true, force: true });
        expect(await json<Overview>(`/overview`)).toMatchObject({ noteCount: 0, linkCount: 0, orphans: [] });
        expect((await json<{ notes: unknown[] }>(`/notes`)).notes).toEqual([]);
    });
});

describe(`the namespace`, () => {
    it(`is the one both halves speak`, () => {
        expect(KNOWLEDGE_BASE).toBe(`/x/intentic.knowledge`);
    });
});
