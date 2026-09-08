import { beforeEach, expect, test, vi } from "vitest";

// Pins sandboxScope's reset list by name, since the failure mode is a new singleton added elsewhere that this
// file never learns to reset. Asserts each reset fires on a real switch and not when the id is merely re-set to
// itself.

const calls: string[] = [];
const record = (name: string) => (): void => void calls.push(name);

vi.mock(`../../agents/fleet/useAgents`, () => ({ resetAgents: record(`resetAgents`) }));
vi.mock(`../../agents/fleet/useAgents-registry`, () => ({ loadArchived: record(`loadArchived`), resetArchive: record(`resetArchive`) }));
vi.mock(`../../chat/run/useChat`, () => ({ resetChat: record(`resetChat`) }));
vi.mock(`../../chat/accounts/useChat-accounts`, () => ({ loadAccountStatus: record(`loadAccountStatus`) }));
vi.mock(`../../workspace/files/useEditBuffers`, () => ({ resetEditBuffers: record(`resetEditBuffers`) }));
vi.mock(`../../../shell/presence/usePresence`, () => ({ resetPresence: record(`resetPresence`) }));
vi.mock(`../../workspace/push/usePushFlow`, () => ({ resetPushFlow: record(`resetPushFlow`) }));
vi.mock(`../../../shell/window/useLayout`, () => ({ resetTerminalOpen: record(`resetTerminalOpen`) }));
vi.mock(`../../workspace/changes/useWorkspaceLive`, () => ({ resetWorkspaceLive: record(`resetWorkspaceLive`) }));
vi.mock(`../../workspace/tabs/useWorkspaceTabs`, () => ({ resetWorkspaceTabs: record(`resetWorkspaceTabs`) }));
vi.mock(`../../workspace/explorer/useWorkspaceTree`, () => ({ resetWorkspaceTreeState: record(`resetWorkspaceTreeState`) }));

// Stands in for useSandbox so the switch can be exercised without the platform client, sandbox list or a connection.
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

// Every reset the switch owns, named rather than counted, so a failure says which one stopped firing.
const ON_SWITCH = [
    `resetChat`,
    `resetEditBuffers`,
    `resetWorkspaceTreeState`,
    `resetWorkspaceTabs`,
    `resetTerminalOpen`,
    `resetWorkspaceLive`,
    `resetPushFlow`,
    `resetPresence`,
    `resetAgents`,
    `resetArchive`,
];

test(`a switch re-scopes every client-side singleton`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();

    expect(calls.filter((name) => ON_SWITCH.includes(name)).toSorted()).toEqual([...ON_SWITCH].toSorted());
});

test(`the workspace half fires again on the next switch: this is per sandbox, not once per page`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    calls.length = 0;

    activeSandboxId.value = `beta`;
    await nextTick();

    expect(calls).toContain(`resetPushFlow`);
    expect(calls).toContain(`resetWorkspaceLive`);
    expect(calls).toContain(`resetAgents`);
});

test(`re-setting the same id resets nothing: a restore from storage is not a switch`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    calls.length = 0;

    activeSandboxId.value = `alpha`;
    await nextTick();

    expect(calls).toEqual([]);
});

// Held wakes are pull-only too, but are read after the hello in systemEvents, not from this seam.
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

    // `reachable` never flips here; the seam must notice the id instead, or two healthy boxes would share state.
    activeSandboxId.value = `beta`;
    await nextTick();

    expect(calls).toContain(`loadArchived`);
    expect(calls).toContain(`loadAccountStatus`);
});
