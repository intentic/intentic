import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { Persona } from "@intentic/sandbox-contract";
import { createApp, h, nextTick, ref } from "vue";
import * as roleModelOriginal from "../../accounts/roleModel";
import * as usePersonasOriginal from "../../../sandbox/personas/usePersonas";

// Pins the persona half of a pane: a pick closes its picker, overrules the router and puts the persona's own model on;
// the notice speaks only for a card that would fail the turn; a guest's chat wears its first card from the start.

// The workspace's cards and which capabilities are signed in; `backend` brings its own model, the others none.
const { personas, signedIn } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return {
        personas: vueRef<Persona[]>([
            { id: `backend`, label: `Backend`, capabilities: [], models: [{ provider: `claude`, model: `claude-opus-5`, effort: `max` }] },
            { id: `social`, capabilities: [] },
            { id: `reddit`, label: `Reddit`, capabilities: [`reddit`] },
        ]),
        signedIn: vueRef<readonly string[]>([]),
    };
})();
jest.mock("../../../sandbox/personas/usePersonas", () => ({
    ...usePersonasOriginal,
    usePersonas: () => ({ personas, isConnected: (capability: string) => signedIn.value.includes(capability) }),
}));
// Claude connected, so a card's Claude model is one this sandbox can run.
jest.mock("../../accounts/roleModel", () => ({ ...roleModelOriginal, roleSources: ref([{ provider: `claude`, ready: true, models: [] }]) }));

const { usePanePersona } = await import("./panePersona");
const { Conversation } = await import("../../session/conversation");

let unmount: (() => void) | undefined;
const personaOf = (guest = false) => {
    const chat = new Conversation(`c1`);
    const route = { byHand: jest.fn() };
    const picked = jest.fn();
    const isGuest = ref(guest);
    let persona: ReturnType<typeof usePanePersona> | undefined;
    const app = createApp({
        setup: () => {
            persona = usePanePersona({ conversation: () => chat, route, isGuest, picked });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { chat, route, picked, isGuest, persona: persona! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    signedIn.value = [];
    resetSandboxScope();
});

describe(`a pick`, () => {
    it(`closes its picker, overrules the router, and puts the persona's own model on`, () => {
        const { chat, route, picked, persona } = personaOf();

        persona.pickPersona(`backend`);

        expect(picked).toHaveBeenCalledTimes(1);
        expect(route.byHand).toHaveBeenCalledTimes(1);
        expect(chat.selection.actsAs.value).toBe(`backend`);
        expect(chat.selection.model.value).toBe(`claude-opus-5`);
        expect(chat.selection.effortPick.value).toBe(`max`);
        expect(persona.personaName.value).toBe(`Backend`);
    });

    it(`leaves the chat's model alone for a persona that brings none, and "Anyone" un-pins`, () => {
        const { chat, route, persona } = personaOf();
        const model = chat.selection.model.value;

        persona.pickPersona(`social`);
        expect(chat.selection.model.value).toBe(model);
        // No label of its own: the id is its name.
        expect(persona.personaName.value).toBe(`social`);

        persona.pickPersona(undefined);
        expect(chat.selection.actsAs.value).toBeUndefined();
        expect(route.byHand).toHaveBeenCalledTimes(2);
    });
});

describe(`the notice`, () => {
    it(`says nothing for an unpinned chat, a card with no accounts, or one signed in`, () => {
        const { chat, persona } = personaOf();
        expect(persona.personaNotice.value).toBeUndefined();

        chat.selection.apply({ kind: `set`, picks: { actsAs: `social` } });
        expect(persona.personaNotice.value).toBeUndefined();

        signedIn.value = [`reddit`];
        chat.selection.apply({ kind: `set`, picks: { actsAs: `reddit` } });
        expect(persona.personaNotice.value).toBeUndefined();
    });

    it(`warns of a card whose accounts aren't signed in, and of one that no longer exists`, () => {
        const { chat, persona } = personaOf();

        chat.selection.apply({ kind: `set`, picks: { actsAs: `reddit` } });
        expect(persona.personaNotice.value).toBe(`Reddit isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`);

        chat.selection.apply({ kind: `set`, picks: { actsAs: `gone` } });
        expect(persona.personaNotice.value).toBe(
            `This chat acts as "gone", which no longer exists: it would reach no account and no tools. Pick another persona.`,
        );
    });
});

describe(`a guest`, () => {
    it(`wears its first card from the first word`, () => {
        const { chat, route } = personaOf(true);

        expect(chat.selection.actsAs.value).toBe(`backend`);
        expect(route.byHand).toHaveBeenCalledTimes(1);
    });

    it(`keeps a card already worn`, async () => {
        const { chat, isGuest, route, persona } = personaOf();
        persona.pickPersona(`social`);

        isGuest.value = true;
        await nextTick();

        expect(chat.selection.actsAs.value).toBe(`social`);
        expect(route.byHand).toHaveBeenCalledTimes(1);
    });

    it(`wears the first card once the role turns out to be a guest's`, async () => {
        const { chat, isGuest } = personaOf();

        isGuest.value = true;
        await nextTick();

        expect(chat.selection.actsAs.value).toBe(`backend`);
    });
});
