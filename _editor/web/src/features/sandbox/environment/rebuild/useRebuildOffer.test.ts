// The rebuild "Rebuild needed" may carry as a press of its own: offered only where that one press is the whole errand,
// and sending exactly what the Environment card's own button sends.
import "@intentic/testing/dom";
import type { HostedBuildState } from "@intentic/api-contract";
import { ref } from "vue";

const active = ref<{ id: string; role: string; hosted: { region: string; warm: boolean } | null }>({
    id: `sb1`,
    role: `owner`,
    hosted: { region: `iad`, warm: true },
});
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
const pending = ref<{ hash: string; content: string } | undefined>({ hash: `h1`, content: `RUN true` });
const proposal = ref<{ hash: string; content: string } | undefined>(undefined);
jest.mock(`../useEnvironment`, () => ({ useEnvironment: () => ({ pending, proposal }) }));
const build = ref<HostedBuildState | undefined>(undefined);
const rebuild = jest.fn().mockResolvedValue({ state: `building`, hash: `h1`, startedAt: `2026-10-06T12:00:00.000Z` });
jest.mock(`../../secrets/useHostedBuild`, () => ({ useHostedBuild: () => ({ build, applied: ref(undefined), rebuild }) }));
const fleet = ref<{ status: string }[]>([]);
jest.mock(`../../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet }) }));

const { useRebuildOffer } = await import("./useRebuildOffer");

afterEach(() => {
    active.value = { id: `sb1`, role: `owner`, hosted: { region: `iad`, warm: true } };
    pending.value = { hash: `h1`, content: `RUN true` };
    proposal.value = undefined;
    build.value = undefined;
    fleet.value = [];
    rebuild.mockClear();
});

it(`offers the hosted owner's rebuild, and sends the recipe the card would`, async () => {
    const offer = useRebuildOffer();
    expect(offer.offered.value).toBe(true);
    await offer.start();
    expect(rebuild).toHaveBeenCalledWith(`h1`, `RUN true`);
});

it.each<[string, () => void]>([
    [`a sandbox on a computer, whose rebuild runs there`, () => (active.value = { ...active.value, hosted: null })],
    [`a reader who is not its owner`, () => (active.value = { ...active.value, role: `maintainer` })],
    [`nothing waiting to be built`, () => (pending.value = undefined)],
    [`a proposal still to decide, which the build would leave out`, () => (proposal.value = { hash: `p1`, content: `RUN more` })],
    [`a build of it already under way`, () => (build.value = { state: `building`, hash: `h1`, startedAt: new Date().toISOString() })],
    [
        `a build of it that failed, whose reason is on the card`,
        () => (build.value = { state: `failed`, hash: `h1`, startedAt: new Date().toISOString() }),
    ],
    [`an agent mid-turn, which the swap at the end would cut`, () => (fleet.value = [{ status: `running` }])],
])(`offers nothing for %s`, (_, arrange) => {
    arrange();
    expect(useRebuildOffer().offered.value).toBe(false);
});
