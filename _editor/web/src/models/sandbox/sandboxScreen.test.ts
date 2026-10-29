import { nextTick, ref } from "vue";

/* Switching sandboxes as a change of SCREEN, not just of daemon: what each sandbox was last showing is what it comes back to. */

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
const replace = jest.fn();
const hooks: AfterEach[] = [];

jest.mock("../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId }) }));
// The person's standing in the sandbox switched to: a guest's first screen is its chat, everyone else's the board.
const guest = ref(false);
jest.mock("../../client/sandbox/useRole", () => ({ useRole: () => ({ isGuest: guest, homeOnly: ref(false) }) }));
const router = { afterEach: (hook: AfterEach) => void hooks.push(hook), currentRoute, replace };
jest.mock("../../workbench/navigation/navigation", () => ({ onNavigation: (run: (installed: typeof router) => void) => run(router) }));

const { sectionEntryPath } = await import("./sandboxScreen");
const { homeFrame, homeSection } = await import("../../lib/routes/homeSection");

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
    guest.value = false;
    currentRoute.value = shellRoute(`/workspace`);
    homeFrame.value = undefined;
    homeSection.value = undefined;
});

describe(`landing on a switched-to sandbox`, () => {
    it(`comes back to the screen that sandbox was last on`, async () => {
        navigate(shellRoute(`/agents`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace/src/foo.ts`));

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    it(`keeps each sandbox's screen apart: switching back and forth lands on both`, async () => {
        navigate(shellRoute(`/sandbox/secrets`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace/src/foo.ts`));
        await switchTo(`sb1`);
        navigate(shellRoute(`/sandbox/secrets`));

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/workspace/src/foo.ts`);
    });

    it(`sends a sandbox this window has never shown to its own first screen, not to the current screen`, async () => {
        navigate(shellRoute(`/agents/agent-of-sb1`));

        await switchTo(`sb-fresh`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    // `/` is Home since Home became the first screen: a switch made inside a sandbox must not bounce out to it.
    it(`never sends a switch to the bare address, which opens Home`, async () => {
        session.set(`intentic.sandboxScreen.sb2`, `/`);

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    it(`lands a guest on its chat, the one screen it has in a box it was let into`, async () => {
        guest.value = true;

        await switchTo(`sb-fresh`);

        expect(replace).toHaveBeenLastCalledWith(`/chat`);
    });

    it(`ignores a stored value that is not a path`, async () => {
        session.set(`intentic.sandboxScreen.sb2`, `agents`);

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    it(`seeds a window that has never held the screen from the last window's`, async () => {
        local.set(`intentic.sandboxScreen.sb2`, `/approvals`);

        await switchTo(`sb2`);

        expect(replace).toHaveBeenLastCalledWith(`/approvals`);
    });
});

describe(`what counts as a sandbox's screen`, () => {
    it(`never records a page outside the shell: /setup belongs to the account`, async () => {
        navigate(outsideRoute(`/setup`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/agents`));

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });

    it(`does not land while the user is outside the shell: the setup flow makes its new sandbox active`, async () => {
        navigate(shellRoute(`/agents`));
        navigate(outsideRoute(`/setup`));

        await switchTo(`sb2`);

        expect(replace).not.toHaveBeenCalled();
    });

    it(`does not record a navigation that failed: the screen nobody reached`, async () => {
        navigate(shellRoute(`/agents`));
        navigate(shellRoute(`/workspace/src/foo.ts`), { type: 8 });
        await switchTo(`sb2`);

        await switchTo(`sb1`);

        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });
});


describe(`the master view spans sandboxes`, () => {
    it(`keeps switching on the master view instead of restoring a sandbox screen`, async () => {
        navigate(shellRoute(`/home`));
        await switchTo(`sb2`);
        expect(replace).not.toHaveBeenCalled();
    });

    it(`does not replace the sandbox's remembered screen with the master view`, async () => {
        navigate(shellRoute(`/agents`));
        navigate(shellRoute(`/home/sb1`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace`));
        await switchTo(`sb1`);
        expect(replace).toHaveBeenLastCalledWith(`/agents`);
    });
});

// Home's frame around the section it shows of every sandbox (lib/routes/homeSection.ts): a switch there stays on that
// section, of the sandbox switched to.
describe(`a switch in Home's frame around a section`, () => {
    const workspace = { id: `workspace`, to: `/workspace`, label: `Workspace` };

    it(`lands on the section, at the screen that sandbox was last on there when it has one`, async () => {
        navigate(shellRoute(`/agents`));
        await switchTo(`sb2`);
        navigate(shellRoute(`/workspace/src/b.ts`));
        homeSection.value = workspace;
        homeFrame.value = `docked`;

        await switchTo(`sb1`);
        expect(replace).toHaveBeenLastCalledWith(`/workspace`);

        await switchTo(`sb2`);
        expect(replace).toHaveBeenLastCalledWith(`/workspace/src/b.ts`);
    });

    it(`is the section's own address for a sandbox never shown, and the remembered screen only when the section owns it`, () => {
        session.set(`intentic.sandboxScreen.sb2`, `/workspace/src/b.ts?agent=cnv_1`);
        session.set(`intentic.sandboxScreen.sb3`, `/workspaces`);

        expect(sectionEntryPath(`sb-fresh`, workspace)).toBe(`/workspace`);
        expect(sectionEntryPath(`sb2`, workspace)).toBe(`/workspace/src/b.ts?agent=cnv_1`);
        expect(sectionEntryPath(`sb3`, workspace)).toBe(`/workspace`);
    });
});
