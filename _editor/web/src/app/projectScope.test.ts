import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { freshImport } from "@intentic/testing/bun";
import { activeSandboxId } from "../features/sandbox/overview/activeSandbox";

// The scope's two halves: the predicate every narrowed source applies, and the selection surviving a reload for
// the sandbox it was made in. jsdom: the selection lives in localStorage.

// The selection is module state read from storage at load, so each case gets its own evaluation of it.
const load = () => freshImport<typeof import("./projectScope")>("./projectScope", import.meta.url);

beforeEach(() => {
    localStorage.clear();
});

describe(`inside a project`, () => {
    it(`is the project itself or a path under it, by segment`, async () => {
        const { inProject } = await load();
        expect(inProject(`shop`, `shop`)).toBe(true);
        expect(inProject(`shop/src/index.ts`, `shop`)).toBe(true);
        expect(inProject(`shop2`, `shop`)).toBe(false);
        expect(inProject(`root`, `shop`)).toBe(false);
    });

    it(`lets everything through while no project is open, and only the project's while one is`, async () => {
        const { withinScope, setProjectScope } = await load();
        expect(withinScope(`api`)).toBe(true);
        setProjectScope(`shop`);
        expect(withinScope(`shop/docs`)).toBe(true);
        expect(withinScope(`api`)).toBe(false);
        setProjectScope(undefined);
        expect(withinScope(`api`)).toBe(true);
    });

    // A repository can be discovered several levels down (repo-discovery walks until it finds one), so the project id
    // can be a path. A walk that pruned by `withinScope` alone would stop at `apps` and never reach the project itself.
    it(`descends a folder the project lives under, which is not itself in scope`, async () => {
        const { reachesScope, withinScope, setProjectScope } = await load();
        setProjectScope(`apps/web`);
        expect(withinScope(`apps`)).toBe(false);
        expect(reachesScope(`apps`)).toBe(true);
        expect(reachesScope(`apps/web/src`)).toBe(true);
        expect(reachesScope(`apps/admin`)).toBe(false);
        expect(reachesScope(`libs`)).toBe(false);
    });
});

describe(`the selection`, () => {
    it(`is remembered for the sandbox and cleared when set to nothing`, async () => {
        const { projectScope, setProjectScope } = await load();
        setProjectScope(`shop`);
        expect(projectScope.value).toBe(`shop`);
        expect(Object.keys(localStorage).some((key) => key.startsWith(`intentic.project.`))).toBe(true);
        setProjectScope(undefined);
        expect(projectScope.value).toBeUndefined();
        expect(Object.keys(localStorage).some((key) => key.startsWith(`intentic.project.`))).toBe(false);
    });

    // A project id is a folder in one sandbox's workspace: a switch opens on whatever the incoming sandbox had open.
    it(`is read again for each sandbox the scope moves to`, async () => {
        const { projectScope, setProjectScope } = await load();
        activeSandboxId.value = `sb-a`;
        setProjectScope(`shop`);

        activeSandboxId.value = `sb-b`;
        resetSandboxScope();
        expect(projectScope.value).toBeUndefined();
        setProjectScope(`api`);

        activeSandboxId.value = `sb-a`;
        resetSandboxScope();
        expect(projectScope.value).toBe(`shop`);
    });
});
