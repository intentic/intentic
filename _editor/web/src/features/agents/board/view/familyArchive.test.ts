import { ref } from "vue";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { useFamilyArchive } from "./familyArchive";

// One tap archived an agent and its seven children with nothing said; a family now asks first, with the count.
const card = (id: string, title = `agent ${id}`): FleetAgent => ({
    id,
    title,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
});

const setup = (coarse = false) => {
    const cards = new Map([card(`lead`, `TABULARIUM`), card(`alone`), ...Array.from({ length: 7 }, (_, at) => card(`child-${at}`))].map((c) => [c.id, c]));
    const archive = jest.fn(async (_ids?: readonly string[], _options?: { readonly receipt?: boolean }) => undefined);
    const familyIds = (of: FleetAgent): string[] => (of.id === `lead` ? [`lead`, ...Array.from({ length: 7 }, (_, at) => `child-${at}`)] : [of.id]);
    const family = useFamilyArchive({ archive, familyIds, agentById: (id) => cards.get(id), coarse: ref(coarse) });
    return { family, archive, cards };
};

describe("useFamilyArchive", () => {
    it("asks before archiving a card with children, naming it and counting them", async () => {
        const { family, archive, cards } = setup();
        await family.request(cards.get(`lead`)!);
        expect(archive).not.toHaveBeenCalled();
        expect(family.pending.value).toEqual({ ids: [`lead`, ...Array.from({ length: 7 }, (_, at) => `child-${at}`)], title: `TABULARIUM`, children: 7 });

        await family.confirm();
        expect(archive.mock.calls).toEqual([[[`lead`, ...Array.from({ length: 7 }, (_, at) => `child-${at}`)], { receipt: false }]]);
        expect(family.pending.value).toBeUndefined();
    });

    it("archives nothing when the reader cancels", async () => {
        const { family, archive } = setup();
        await family.requestIds([`lead`]);
        family.cancel();
        await family.confirm();
        expect(archive).not.toHaveBeenCalled();
    });

    it("archives a card with no children at once, with an Undo receipt on a touch screen", async () => {
        const { family, archive } = setup(true);
        await family.requestIds([`alone`]);
        expect(archive.mock.calls).toEqual([[[`alone`], { receipt: true }]]);
        expect(family.pending.value).toBeUndefined();
    });

    it("leaves the lane's Clear as it was", async () => {
        const { family, archive } = setup();
        await family.requestIds(undefined);
        expect(archive.mock.calls).toEqual([[undefined]]);
    });
});
