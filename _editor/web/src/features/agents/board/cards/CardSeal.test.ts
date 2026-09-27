import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import CardSeal from "./CardSeal.vue";
import type { ProofMark } from "./proofSeal";

// THE SEAL IS A MARK, NEVER A PRESS: what the card's last turn showed of its own work, one glyph whose words are its
// hover. Nothing on it moves, since the card's own status glyph is what moves while a turn works.

let app: App | undefined;

const mount = async (props: { proof: ProofMark; quiet?: boolean; status?: string }): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(CardSeal, props) });
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return el.querySelector<HTMLElement>(`[data-seal]`)!;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

// The hover, one reading per line; the glyph's accessible name is the same words.
const readings = (seal: HTMLElement): string[] => seal.querySelector(`svg`)?.getAttribute(`aria-label`)?.split(`\n`) ?? [];
const inks = (seal: HTMLElement): string[] => [`text-success`, `text-muted`, `text-danger`].filter((ink) => seal.classList.contains(ink));

it(`closes in green, and in the row's own ink on a receipt, where a pass is history`, async () => {
    const proof: ProofMark = { verification: `verified`, check: `pnpm test` };
    const seal = await mount({ proof });
    expect([seal.dataset[`sealKind`], inks(seal)]).toEqual([`closed`, [`text-success`]]);
    app?.unmount();
    expect(inks(await mount({ proof, quiet: true }))).toEqual([`text-muted`]);
});

it(`breaks in red on a failed check, a receipt's included`, async () => {
    const seal = await mount({ proof: { verification: `failing` }, quiet: true });
    expect([seal.dataset[`sealKind`], inks(seal), readings(seal)]).toEqual([`broke`, [`text-danger`], [`Its own check: failed`]]);
});

// A tooltip is 17rem wide and five lines tall, and a targeted test command could fill it on its own.
it(`leads its hover with the status it stands in for, one reading a line, a long command clipped`, async () => {
    const check = `pnpm --filter @intentic/web test src/features/agents/board/cards/AgentCard.test.ts`;
    const seal = await mount({ proof: { verification: `verified`, check, unviewed: 1 }, status: `Landed` });
    expect(readings(seal)).toEqual([
        `Landed`,
        `Its own check: pnpm --filter @intentic/web test src/featur… passed`,
        `Changed 1 interface file without looking`,
    ]);
});

it(`is a still mark, never a press, so a click on it is the card's`, async () => {
    const seal = await mount({ proof: { verification: `unproven` } });
    expect([seal.tagName, seal.dataset[`sealKind`], seal.querySelectorAll(`animate`).length]).toEqual([`SPAN`, `open`, 0]);
});
