import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Switching sandboxes as a change of SCREEN, not just of daemon: what each sandbox was last showing is what it
 * comes back to. The router is a stub — what is under test is which fullPath is filed under which sandbox and
 * what a switch does with it, and the real router would only add a history implementation to that. */

// The node test environment has neither storage; windowStore itself is real (its own two-store rules are what
// make a screen this window's own).
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

// One matched record is all inShell reads: `/` is the shell's own path, anything else is a page outside it.
const shellRoute = (fullPath: string) => ({ fullPath, matched: [{ path: `/` }, { path: fullPath }] });
const outsideRoute = (fullPath: string) => ({ fullPath, matched: [{ path: fullPath }] });

type Landing = ReturnType<typeof shellRoute>;
type AfterEach = (to: Landing, from: Landing, failure?: unknown) => void;

const activeSandboxId = ref<string | undefined>(`sb1`);
const currentRoute = ref<Landing>(shellRoute(`/workspace`));
const replace = vi.fn();
const hooks: AfterEach[] = [];

vi.mock("./useSandbox", () => ({ useSandbox: () => ({ activeSandboxId }) }));
vi.mock("../../router", () => ({
    router: { afterEach: (hook: AfterEach) => void hooks.push(hook), currentRoute, replace },
}));

await import("./sandboxScreen");

// A navigation that landed, as the router reports it: the route becomes current, then the afterEach hooks run.
const navigate = (to: Landing, failure?: unknown): void => {
    const from = currentRoute.value;
    if (failure === undefined) {
        currentRoute.value = to;
    }
    for (const hook of hooks) {
        hook(to, from, failure);
    }
};

// The switcher's own gesture (Alt+N → select): the id changes, and the landing is a post-flush watcher.
const switchTo = async (sandboxId: string): Promise<void> => {
    activeSandboxId.value = sandboxId;
    await nextTick();
};

beforeEach(() => {
    local.clear();
    session.clear();
    replace.mockClear();
    activeSandboxId.value = `sb1`;
    currentRoute.value = shellRoute(`/workspace`);
});

describe(`landing on a switched-to sandbox`, () => {
    it(`comes back to the screen that sandbox was last on`, async () => {
        navigate(shellRoute(`/agents`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace/src/foo.ts`));

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    it(`keeps each sandbox's screen apart — switching back and forth lands on both`, async () => {
        navigate(shellRoute(`/sandbox/secrets`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace/src/foo.ts`));
        await switchTo(`sb1`);
        navigate(shellRoute(`/sandbox/secrets`));

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/workspace/src/foo.ts`);
    });

    it(`sends a sandbox this window has never shown to the shell's home, not to the current screen`, async () => {
        navigate(shellRoute(`/agents/agent-of-sb1`));

        await switchTo(`sb-fresh`);

        expect(replace).toHaveBeenLastCalledWith(`/`);
    });

    it(`ignores a stored value that is not a path`, async () => {
        session.set(`intentic.sandboxScreen.sb2`, `agents`);

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/`);
    });

    it(`seeds a window that has never held the screen from the last window's`, async () => {
        local.set(`intentic.sandboxScreen.sb2`, `/drafts`);

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/drafts`);
    });
});

describe(`what counts as a sandbox's screen`, () => {
    it(`never records a page outside the shell — /setup belongs to the account`, async () => {
        navigate(outsideRoute(`/setup`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/agents`));

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/`);
    });

    it(`does not land while the user is outside the shell — the setup flow makes its new sandbox active`, async () => {
        navigate(shellRoute(`/agents`));
        navigate(outsideRoute(`/setup`));

        await switchTo(`sb2`);

        expect(replace).not.toHaveBeenCalled();
    });

    it(`does not record a navigation that failed — the screen nobody reached`, async () => {
        navigate(shellRoute(`/agents`));
        navigate(shellRoute(`/workspace/src/foo.ts`), { type: 8 });
        await switchTo(`sb2`);

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });
});
