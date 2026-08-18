import { beforeEach, expect, test, vi } from "vitest";

/* THE ONE CENTRAL RE-SCOPE, held to its list.
 *
 * sandboxScope is a watch and a set of calls, so what can go wrong with it is not logic — it is OMISSION. A
 * singleton gains a home in `composables/`, nothing here learns about it, and it quietly carries one
 * workspace's data into the next: the outgoing push offered from the wrong repositories, tree rows flashing for
 * edits made in the box you left. Every reset that was missing when this file was written had been missing
 * since the day the state was added.
 *
 * So each reset is asserted to FIRE, by name, on a switch — and asserted not to fire when the id is merely
 * re-set to what it already was, which happens on every restore from storage. */

const calls: string[] = [];
const record = (name: string) => (): void => void calls.push(name);

vi.mock(`../agents/useAgents`, () => ({
    loadArchived: record(`loadArchived`),
    resetAgents: record(`resetAgents`),
    resetArchive: record(`resetArchive`),
}));
vi.mock(`../chat/useChat`, () => ({ loadAccountStatus: record(`loadAccountStatus`), resetChat: record(`resetChat`) }));
vi.mock(`../workspace/useCodeStats`, () => ({ resetCodeStats: record(`resetCodeStats`) }));
vi.mock(`../workspace/useEditBuffers`, () => ({ resetEditBuffers: record(`resetEditBuffers`) }));
vi.mock(`../usePresence`, () => ({ resetPresence: record(`resetPresence`) }));
vi.mock(`../workspace/usePushFlow`, () => ({ resetPushFlow: record(`resetPushFlow`) }));
vi.mock(`../useLayout`, () => ({ resetTerminalOpen: record(`resetTerminalOpen`) }));
vi.mock(`../workspace/useWorkspaceLive`, () => ({ resetWorkspaceLive: record(`resetWorkspaceLive`) }));
vi.mock(`../workspace/useWorkspaceTabs`, () => ({ resetWorkspaceTabs: record(`resetWorkspaceTabs`) }));
vi.mock(`../workspace/useWorkspaceTree`, () => ({ resetWorkspaceTreeState: record(`resetWorkspaceTreeState`) }));

/* The two refs the module actually reads. Standing in for useSandbox rather than driving the real one is the
 * point of sandboxScope living apart from it: it can be exercised without the platform client, the sandbox
 * list, or a connection — which is also why the switch it watches for is reproducible in a test at all. */
const { activeSandboxId, reachable } = await vi.hoisted(async () => {
    const { ref } = await import(`vue`);
    return { activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) };
});
vi.mock(`./useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId, reachable }) }));

await import("./sandboxScope");
const { nextTick } = await import("vue");

beforeEach(() => {
    calls.length = 0;
});

// Every reset the switch is responsible for. Named rather than counted: a failure should say WHICH one stopped
// being called, since that is the whole failure mode this guards.
const ON_SWITCH = [
    `resetChat`,
    `resetEditBuffers`,
    `resetWorkspaceTreeState`,
    `resetWorkspaceTabs`,
    `resetTerminalOpen`,
    `resetWorkspaceLive`,
    `resetPushFlow`,
    `resetCodeStats`,
    `resetPresence`,
    `resetAgents`,
    `resetArchive`,
];

test(`a switch re-scopes every client-side singleton`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();

    expect(calls.filter((name) => ON_SWITCH.includes(name)).toSorted()).toEqual([...ON_SWITCH].toSorted());
});

test(`the workspace half fires again on the next switch — this is per sandbox, not once per page`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    calls.length = 0;

    activeSandboxId.value = `beta`;
    await nextTick();

    expect(calls).toContain(`resetPushFlow`);
    expect(calls).toContain(`resetWorkspaceLive`);
    expect(calls).toContain(`resetAgents`);
});

test(`re-setting the same id resets nothing — a restore from storage is not a switch`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    calls.length = 0;

    activeSandboxId.value = `alpha`;
    await nextTick();

    expect(calls).toEqual([]);
});

/* The pull-only half — what the daemon holds and no stream frame carries. Held wakes are NOT among them and
 * that is deliberate: a roster read fired from this seam lands on a revision line the incoming hello is about
 * to replace, so it discards its own answer. sandboxScope's closing comment carries the reasoning; the read
 * itself lives in systemEvents, after the hello. */
test(`becoming reachable reloads what lives on the daemon, without resetting anything`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    calls.length = 0;

    reachable.value = true;
    await nextTick();

    expect(calls.toSorted()).toEqual([`loadAccountStatus`, `loadArchived`]);
});

test(`switching between two reachable sandboxes still re-reads it`, async () => {
    activeSandboxId.value = `alpha`;
    reachable.value = true;
    await nextTick();
    calls.length = 0;

    // `reachable` never flips here, so the seam has to notice the ID instead — otherwise a switch between two
    // healthy boxes shows the first one's archive against the second one's name.
    activeSandboxId.value = `beta`;
    await nextTick();

    expect(calls).toContain(`loadArchived`);
    expect(calls).toContain(`loadAccountStatus`);
});
