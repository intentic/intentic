import { resetSandboxScope, sandboxRef, sandboxValue } from "@intentic/extension-api";

// The switch point: a switch resets every value declared through the sandbox scope, wherever it was declared (an
// editor store or an extension), and a new scope re-reads what lives on the daemon once it is reachable. Only the
// daemon reads are stood in for; the scope itself is the real one.

const calls: string[] = [];
const record = (name: string) => (): void => void calls.push(name);

jest.mock(`../../agents/fleet/useAgents-registry`, () => ({ loadArchived: record(`loadArchived`) }));
jest.mock(`../../chat/accounts/useChat-accounts`, () => ({ loadAccountStatus: record(`loadAccountStatus`) }));

// Stands in for useSandbox so the switch can be exercised without the platform client, sandbox list or a connection.
const { activeSandboxId, reachable } = await (async () => {
    const { ref } = await import(`vue`);
    return { activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) };
})();
jest.mock(`./useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId, reachable }) }));

await import("./sandboxScope");
const { nextTick } = await import("vue");

// One store's state, declared the way the editor declares it, holding what a sandbox filled in and what a switch ends.
const disposed: string[] = [];
const roster = sandboxRef<readonly string[]>(() => []);
const stream = sandboxValue(
    () => `idle`,
    (previous) => void disposed.push(previous),
);

beforeEach(async () => {
    activeSandboxId.value = undefined;
    reachable.value = false;
    await nextTick();
    calls.length = 0;
    disposed.length = 0;
});

test(`a switch returns every scoped value to its initial and disposes what the last sandbox held`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    disposed.length = 0;
    roster.value = [`agent-1`];
    stream.value = `attached to agent-1`;

    activeSandboxId.value = `beta`;
    await nextTick();

    expect(roster.value).toEqual([]);
    expect(stream.value).toBe(`idle`);
    expect(disposed).toEqual([`attached to agent-1`]);
});

// The same primitive the extensions declare their state with: one registry, one switch.
test(`an extension's scoped state goes with the editor's on the same switch`, async () => {
    const badge = sandboxRef(() => 0);
    activeSandboxId.value = `alpha`;
    await nextTick();
    badge.value = 21;

    activeSandboxId.value = `beta`;
    await nextTick();

    expect(badge.value).toBe(0);
});

test(`re-setting the same id resets nothing: a restore from storage is not a switch`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    disposed.length = 0;
    roster.value = [`agent-1`];

    activeSandboxId.value = `alpha`;
    await nextTick();

    expect(roster.value).toEqual([`agent-1`]);
    expect(disposed).toEqual([]);
});

// Held wakes are pull-only too, but are read after the hello in systemEvents, not from this seam.
test(`becoming reachable reloads what lives on the daemon, without resetting anything`, async () => {
    activeSandboxId.value = `alpha`;
    await nextTick();
    roster.value = [`agent-1`];
    calls.length = 0;

    reachable.value = true;
    await nextTick();

    expect(calls.toSorted()).toEqual([`loadAccountStatus`, `loadArchived`]);
    expect(roster.value).toEqual([`agent-1`]);
});

test(`switching between two reachable sandboxes still re-reads it`, async () => {
    activeSandboxId.value = `alpha`;
    reachable.value = true;
    await nextTick();
    calls.length = 0;

    // `reachable` never flips here; the seam must notice the new scope instead, or two healthy boxes would share state.
    activeSandboxId.value = `beta`;
    await nextTick();

    expect(calls.toSorted()).toEqual([`loadAccountStatus`, `loadArchived`]);
});

// A workspace replaced under the same sandbox id (systemEvents' hello) is a new scope with no id change to watch.
test(`a new scope under the same id re-reads it too`, async () => {
    activeSandboxId.value = `alpha`;
    reachable.value = true;
    await nextTick();
    calls.length = 0;

    resetSandboxScope();
    await nextTick();

    expect(calls.toSorted()).toEqual([`loadAccountStatus`, `loadArchived`]);
});
