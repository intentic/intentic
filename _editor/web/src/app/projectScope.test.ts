import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { RESERVED_PROJECT_DIR_NAMES } from "@intentic/sandbox-contract";
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

// What the store holds for the scope, whichever sandbox is active.
const stored = (): (string | null)[] =>
    Object.keys(localStorage)
        .filter((key) => key.startsWith(`intentic.project.`))
        .map((key) => localStorage.getItem(key));

describe(`the selection`, () => {
    // Everything is kept as a choice too, not as nothing chosen: a project sandbox's hello must not narrow it again.
    it(`is remembered for the sandbox, a return to everything included`, async () => {
        const { projectScope, setProjectScope } = await load();
        setProjectScope(`shop`);
        expect(projectScope.value).toBe(`shop`);
        expect(stored()).toEqual([`shop`]);
        setProjectScope(undefined);
        expect(projectScope.value).toBeUndefined();
        expect(stored()).toEqual([``]);
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

// The daemon's hello names a project sandbox's folder on every connect. The first time this browser hears it, the
// workspace opens on that folder; from then on the scope is the owner's.
describe(`a project sandbox's own folder`, () => {
    it(`becomes the scope while nothing is stored for the sandbox`, async () => {
        activeSandboxId.value = `sb-a`;
        const { projectScope, adoptProjectScope } = await load();
        adoptProjectScope(`sb-a`, `my-app`);
        expect(projectScope.value).toBe(`my-app`);
        expect(stored()).toEqual([`my-app`]);
    });

    it(`never overrules a scope already chosen, a return to everything included`, async () => {
        activeSandboxId.value = `sb-a`;
        const { projectScope, setProjectScope, adoptProjectScope } = await load();
        setProjectScope(`my-app/packages/web`);
        adoptProjectScope(`sb-a`, `my-app`);
        const narrowed = projectScope.value;
        setProjectScope(undefined);
        adoptProjectScope(`sb-a`, `my-app`);
        expect({ narrowed, widened: projectScope.value }).toEqual({ narrowed: `my-app/packages/web`, widened: undefined });
    });

    // The hello names the sandbox it came from, which a switch may have taken out of view.
    it(`is kept for the sandbox that named it, without moving the one in view`, async () => {
        activeSandboxId.value = `sb-b`;
        const { projectScope, adoptProjectScope } = await load();
        adoptProjectScope(`sb-a`, `my-app`);
        const inView = projectScope.value;
        activeSandboxId.value = `sb-a`;
        resetSandboxScope();
        expect({ inView, afterSwitch: projectScope.value }).toEqual({ inView: undefined, afterSwitch: `my-app` });
    });

    it(`is refused when it names no folder a project could be, and taken once it does`, async () => {
        activeSandboxId.value = `sb-a`;
        const { projectScope, adoptProjectScope } = await load();
        adoptProjectScope(`sb-a`, `../elsewhere`);
        adoptProjectScope(`sb-a`, RESERVED_PROJECT_DIR_NAMES[0]!);
        const refused = projectScope.value;
        adoptProjectScope(`sb-a`, `my-app`);
        expect({ refused, taken: projectScope.value }).toEqual({ refused: undefined, taken: `my-app` });
    });
});

// The desktop app opening a project's sandbox from the folder's own window (`/?sandbox=<id>&project=<folder>`): the reader
// asked to see that folder, so it is the scope even over a choice stored before, and it is kept as the choice.
describe(`a project sandbox opened from its folder's window`, () => {
    it(`opens on the folder over a scope chosen before, and keeps it`, async () => {
        activeSandboxId.value = `sb-a`;
        const { projectScope, setProjectScope, openOnProject, adoptProjectScope } = await load();
        setProjectScope(undefined);
        openOnProject(`sb-a`, `test-remove-me`);
        adoptProjectScope(`sb-a`, `test-remove-me`);
        expect({ scope: projectScope.value, stored: stored() }).toEqual({ scope: `test-remove-me`, stored: [`test-remove-me`] });
    });

    it(`is kept for the sandbox it names when another is in view`, async () => {
        activeSandboxId.value = `sb-b`;
        const { projectScope, openOnProject } = await load();
        openOnProject(`sb-a`, `test-remove-me`);
        const inView = projectScope.value;
        activeSandboxId.value = `sb-a`;
        resetSandboxScope();
        expect({ inView, afterSwitch: projectScope.value }).toEqual({ inView: undefined, afterSwitch: `test-remove-me` });
    });

    it(`is refused when it names no folder a project could be`, async () => {
        activeSandboxId.value = `sb-a`;
        const { projectScope, openOnProject } = await load();
        openOnProject(`sb-a`, `../elsewhere`);
        openOnProject(`sb-a`, RESERVED_PROJECT_DIR_NAMES[0]!);
        expect({ scope: projectScope.value, stored: stored() }).toEqual({ scope: undefined, stored: [] });
    });
});
