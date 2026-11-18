import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { createApp, h, nextTick, ref } from "vue";
import * as roleModelOriginal from "../../../../../models/providers/roleModel";
import * as useRolesOriginal from "../../../../../models/sandbox/roles/useRoles";

// Pins the role half of a pane: a pick closes its picker, overrules the router and puts the role's own model on;
// the notice speaks only for a card that would fail the turn; a guest's chat wears its first card from the start.

// The workspace's cards and which capabilities are signed in; `backend` brings its own model, the others none.
const { roles, signedIn } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return {
        roles: vueRef<Role[]>([
            { id: `backend`, label: `Backend`, capabilities: [], models: [{ provider: `claude`, model: `claude-opus-5`, effort: `max` }] },
            { id: `social`, capabilities: [] },
            { id: `reddit`, label: `Reddit`, capabilities: [`reddit`] },
        ]),
        signedIn: vueRef<readonly string[]>([]),
    };
})();
jest.mock("../../../../../models/sandbox/roles/useRoles", () => ({
    ...useRolesOriginal,
    useRoles: () => ({ roles, isConnected: (capability: string) => signedIn.value.includes(capability) }),
}));
// The board's summary of each conversation: the role its last turn wore, or the one a person switched it to.
const fleet = ref<{ id: string; lastActsAs?: string }[]>([]);
jest.mock("../../../../../models/fleet/useAgents", () => ({ useAgents: () => ({ agentById: (id: string) => fleet.value.find((agent) => agent.id === id) }) }));
// Claude connected, so a card's Claude model is one this sandbox can run.
jest.mock("../../../../../models/providers/roleModel", () => ({ ...roleModelOriginal, roleSources: ref([{ provider: `claude`, ready: true, models: [] }]) }));

const { usePaneRole } = await import("../paneRole");
const { Conversation } = await import("../../../../../models/conversations/session/conversation");

let unmount: (() => void) | undefined;
const roleOf = (guest = false) => {
    const chat = new Conversation(`c1`);
    const route = { byHand: jest.fn() };
    const picked = jest.fn();
    const isGuest = ref(guest);
    let role: ReturnType<typeof usePaneRole> | undefined;
    const app = createApp({
        setup: () => {
            role = usePaneRole({ conversation: () => chat, route, isGuest, picked });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { chat, route, picked, isGuest, role: role! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    signedIn.value = [];
    fleet.value = [];
    resetSandboxScope();
});

describe(`a switch made elsewhere`, () => {
    // A grant need's card put the conversation on another role: the pill follows, so the next message keeps it.
    it(`follows the role the conversation was switched to, and clears the pick for All accounts`, async () => {
        const { chat, role } = roleOf();
        fleet.value = [{ id: chat.conversationId }];
        role.pickRole(`social`);
        await nextTick();

        fleet.value = [{ id: chat.conversationId, lastActsAs: `backend` }];
        await nextTick();
        expect(chat.selection.actsAs.value).toBe(`backend`);

        fleet.value = [{ id: chat.conversationId, lastActsAs: `full-access` }];
        await nextTick();
        expect(chat.selection.actsAs.value).toBeUndefined();
    });

    it(`leaves a pick made since alone while the conversation wears what it was already wearing`, async () => {
        const { chat, role } = roleOf();
        fleet.value = [{ id: chat.conversationId, lastActsAs: `social` }];
        await nextTick();
        role.pickRole(`reddit`);
        fleet.value = [{ id: chat.conversationId, lastActsAs: `social` }];
        await nextTick();
        expect(chat.selection.actsAs.value).toBe(`reddit`);
    });
});

describe(`a pick`, () => {
    it(`closes its picker, overrules the router, and puts the role's own model on`, () => {
        const { chat, route, picked, role } = roleOf();

        role.pickRole(`backend`);

        expect(picked).toHaveBeenCalledTimes(1);
        expect(route.byHand).toHaveBeenCalledTimes(1);
        expect(chat.selection.actsAs.value).toBe(`backend`);
        expect(chat.selection.model.value).toBe(`claude-opus-5`);
        expect(chat.selection.effortPick.value).toBe(`max`);
        expect(role.roleName.value).toBe(`Backend`);
    });

    it(`leaves the chat's model alone for a role that brings none, and All accounts un-pins`, () => {
        const { chat, route, role } = roleOf();
        const model = chat.selection.model.value;

        role.pickRole(`social`);
        expect(chat.selection.model.value).toBe(model);
        // No label of its own: the id is its name.
        expect(role.roleName.value).toBe(`social`);

        role.pickRole(undefined);
        expect(chat.selection.actsAs.value).toBeUndefined();
        expect(route.byHand).toHaveBeenCalledTimes(2);
        // No pick is the All accounts built-in, named and marked as such rather than left blank.
        expect(role.roleName.value).toBe(`All accounts`);
        expect(role.roleIcon.value).toBe(`users`);
    });

    it(`names No accounts, gives it its own mark, and never calls a built-in gone`, () => {
        const { role } = roleOf();

        role.pickRole(`no-accounts`);
        expect(role.roleName.value).toBe(`No accounts`);
        expect(role.roleIcon.value).toBe(`lock`);
        expect(role.roleNotice.value).toBeUndefined();
    });
});

describe(`the notice`, () => {
    it(`says nothing for an unpinned chat, a card with no accounts, or one signed in`, () => {
        const { chat, role } = roleOf();
        expect(role.roleNotice.value).toBeUndefined();

        chat.selection.apply({ kind: `set`, picks: { actsAs: `social` } });
        expect(role.roleNotice.value).toBeUndefined();

        signedIn.value = [`reddit`];
        chat.selection.apply({ kind: `set`, picks: { actsAs: `reddit` } });
        expect(role.roleNotice.value).toBeUndefined();
    });

    it(`warns of a card whose accounts aren't signed in, and of one that no longer exists`, () => {
        const { chat, role } = roleOf();

        chat.selection.apply({ kind: `set`, picks: { actsAs: `reddit` } });
        expect(role.roleNotice.value).toBe(`Reddit isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`);

        chat.selection.apply({ kind: `set`, picks: { actsAs: `gone` } });
        expect(role.roleNotice.value).toBe(
            `This chat acts as "gone", which no longer exists: it would reach no account and no tools. Pick another role.`,
        );
    });
});

describe(`a guest`, () => {
    it(`wears its first card from the first word`, () => {
        const { chat, route } = roleOf(true);

        expect(chat.selection.actsAs.value).toBe(`backend`);
        expect(route.byHand).toHaveBeenCalledTimes(1);
    });

    it(`keeps a card already worn`, async () => {
        const { chat, isGuest, route, role } = roleOf();
        role.pickRole(`social`);

        isGuest.value = true;
        await nextTick();

        expect(chat.selection.actsAs.value).toBe(`social`);
        expect(route.byHand).toHaveBeenCalledTimes(1);
    });

    it(`wears the first card once the role turns out to be a guest's`, async () => {
        const { chat, isGuest } = roleOf();

        isGuest.value = true;
        await nextTick();

        expect(chat.selection.actsAs.value).toBe(`backend`);
    });
});
