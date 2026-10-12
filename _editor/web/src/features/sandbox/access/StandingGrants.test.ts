// The Access tab's conversation permissions: which conversation each yes belongs to and whether it can still use it, each
// yes in words with its own Revoke, and a conversation's whole set taken back at once.
import "@intentic/testing/dom";
import type { GrantRevoke, StandingGrants } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

type StandingConversation = StandingGrants["conversations"][number];

const standing = ref<readonly StandingConversation[]>([]);
const revoked: GrantRevoke[] = [];
jest.mock(`./useStandingGrants`, () => ({
    useStandingGrants: () => ({
        conversations: standing,
        // The yeses that name no conversation have a group of their own (SandboxAccess.test.ts covers it); none here.
        ownerWide: ref([]),
        unreadable: ref([]),
        error: ref(undefined),
        revoke: {
            mutateAsync: async (grant: GrantRevoke) => {
                revoked.push(grant);
            },
        },
    }),
}));

// Two halves of the roster, as the fleet store keeps them: what is on the board, and what was put away. The archive is
// read only when a conversation here is on neither.
interface Agent {
    id: string;
    title?: string;
    status: `idle` | `running`;
    archivedAt?: number;
}
const fleet = ref<Agent[]>([]);
const archived = ref<Agent[]>([]);
const archiveLoading = ref(false);
const loadArchived = jest.fn(async () => undefined);
jest.mock(`../../agents/fleet/useAgents`, () => ({
    useAgents: () => ({
        fleet,
        archiveLoading,
        loadArchived: () => loadArchived(),
        agentById: (id: string) => fleet.value.find((agent) => agent.id === id) ?? archived.value.find((agent) => agent.id === id),
    }),
}));
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));

const { default: StandingGrantsView } = await import("./StandingGrants.vue");
const { forgetOperations } = await import("../../../workbench/operations/operations");

const HOUR = 3_600_000;
const conversation = (conversationId: string, over: Partial<StandingConversation> = {}): StandingConversation => ({
    conversationId,
    capabilities: [],
    folders: [],
    shelves: [],
    installs: false,
    secrets: [],
    everything: false,
    rules: [],
    releases: [],
    ...over,
});

let app: App | undefined;
const mount = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(StandingGrantsView) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] }));
    app.mount(el);
    await settle();
};

const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 3; tick += 1) {
        await nextTick();
    }
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

const shown = (): string => document.body.textContent ?? ``;
const buttons = (label: string): HTMLElement[] =>
    [...document.body.querySelectorAll<HTMLElement>(`button, a`)].filter((button) => button.textContent?.trim() === label);
// The conversation rows in the order drawn, by the title each leads with.
const titles = (): string[] => [...document.body.querySelectorAll(`ul[aria-label]`)].map((list) => list.getAttribute(`aria-label`) ?? ``);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    standing.value = [];
    fleet.value = [];
    archived.value = [];
    archiveLoading.value = false;
    revoked.length = 0;
    loadArchived.mockClear();
    forgetOperations();
});

it(`draws nothing while nothing stands`, async () => {
    await mount();
    expect(shown()).toBe(``);
});

it(`names the conversation, where it stands and who allowed it, apart from what it may do`, async () => {
    fleet.value = [{ id: `c1`, title: `Git push`, status: `idle` }];
    standing.value = [conversation(`c1`, { everything: true, secrets: [`github/token`], by: `owner@example.com`, updatedAt: Date.now() - 2 * HOUR })];
    await mount();

    expect(shown()).toContain(`Conversation permissions`);
    expect(shown()).toContain(`Git push`);
    expect(shown()).toMatch(/Idle · last allowed by you, 2\s?h(ours)? ago/);
    expect(shown()).toContain(`May do anything without asking you`);
    expect(shown()).toContain(`May send github/token to any host, not only its own`);
    // The conversation is a place to go, said as one, rather than a title that happens to be a link.
    expect(buttons(`Open`)[0]?.getAttribute(`href`)).toBe(`/agents/c1`);
    expect(buttons(`Revoke`)).toHaveLength(2);
    // On a live conversation nothing is put away, so nothing is said about bringing it back, and the archive is not read.
    expect(shown()).not.toContain(`Archived`);
    expect(loadArchived).not.toHaveBeenCalled();
});

it(`says an archived conversation holds its permissions unused, and lists it after the live ones`, async () => {
    fleet.value = [{ id: `live`, title: `Komodo route`, status: `running` }];
    // Put away, so the live roster does not hold it: the list reads the archive to find out where it went.
    loadArchived.mockImplementationOnce(async () => {
        archived.value = [{ id: `old`, title: `Git push`, status: `idle`, archivedAt: Date.now() - 3 * 24 * HOUR }];
    });
    standing.value = [conversation(`old`, { everything: true }), conversation(`live`, { installs: true })];
    await mount();

    expect(loadArchived).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([`What Komodo route may do`, `What Git push may do`]);
    expect(shown()).toMatch(/Archived 3\s?d(ays)? ago: none of this applies unless it is brought back/);
});

it(`says so when a conversation is on neither the board nor in the archive, and offers no page to open`, async () => {
    standing.value = [conversation(`gone`, { folders: [`refs/stripe`] })];
    await mount();

    expect(loadArchived).toHaveBeenCalledTimes(1);
    expect(shown()).toContain(`Unknown conversation`);
    expect(shown()).toContain(`Not on the board or in the archive`);
    expect(shown()).toContain(`May work in refs/stripe, outside its area`);
    expect(buttons(`Open`)).toHaveLength(0);
});

it(`revokes the one permission pressed, or every one a conversation holds`, async () => {
    fleet.value = [{ id: `c1`, title: `Checkout`, status: `idle` }];
    standing.value = [
        conversation(`c1`, { installs: true, rules: [{ capability: `github`, rule: `ask GET x`, said: `GET x with GitHub` }] }),
    ];
    await mount();

    buttons(`Revoke`)[1]?.click();
    await settle();
    expect(revoked).toEqual([{ conversationId: `c1`, kind: `rule`, what: `ask GET x`, capability: `github` }]);

    revoked.length = 0;
    buttons(`Revoke all`)[0]?.click();
    await settle();
    expect(revoked).toEqual([
        { conversationId: `c1`, kind: `install`, what: `` },
        { conversationId: `c1`, kind: `rule`, what: `ask GET x`, capability: `github` },
    ]);
});

it(`offers Revoke all only where there is more than one thing to take back`, async () => {
    fleet.value = [{ id: `c1`, title: `Checkout`, status: `idle` }];
    standing.value = [conversation(`c1`, { installs: true })];
    await mount();
    expect(buttons(`Revoke all`)).toHaveLength(0);
});
