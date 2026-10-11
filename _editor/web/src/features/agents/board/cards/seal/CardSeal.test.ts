import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import CardSeal from "./CardSeal.vue";
import type { ProofMark } from "./proofSeal";

// THE SEAL IS A MARK, NEVER A PRESS: what the card's last turn showed of its own work, one glyph whose words are the
// small card a staying pointer raises (and its accessible name). Nothing on it moves, since the card's own status glyph is what moves while a turn works.

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

// The readings, one a line: the seal's accessible name, the same words its card says.
const readings = (seal: HTMLElement): string[] => seal.getAttribute(`aria-label`)?.split(`\n`) ?? [];
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
    expect([seal.dataset[`sealKind`], inks(seal), readings(seal)]).toEqual([`broke`, [`text-danger`], [`Its last check failed`]]);
});

it(`leads with the status it stands in for, then the verdict, the whole command and what it changed unseen`, async () => {
    const check = `pnpm --filter @intentic/web test src/features/agents/board/cards/AgentCard.test.ts`;
    const seal = await mount({ proof: { verification: `verified`, check, unviewed: 1 }, status: `Landed` });
    expect(readings(seal)).toEqual([
        `Landed`,
        `Tested after its last edit`,
        check,
        `Changed 1 interface file without looking at the result`,
    ]);
});

it(`is a still mark, never a press, so a click on it is the card's`, async () => {
    const seal = await mount({ proof: { verification: `unproven` } });
    expect([seal.tagName, seal.dataset[`sealKind`], seal.querySelectorAll(`animate`).length]).toEqual([`SPAN`, `open`, 0]);
});

it(`says the whole reading on a card a staying pointer raises, not a tooltip`, async () => {
    const seal = await mount({ proof: { verification: `unproven` }, status: `Landed` });
    // The overlay closes on an anchor with no size, which is every element in a DOM that lays nothing out.
    seal.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 16, height: 16 });
    seal.dispatchEvent(new PointerEvent(`pointerenter`, { pointerType: `mouse` }));
    // Nothing for a pointer passing through.
    expect(document.querySelector(`[data-seal-card]`)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 260));
    await nextTick();
    const card = document.querySelector<HTMLElement>(`[data-seal-card]`)?.textContent ?? ``;
    expect(card).toContain(`Not tested after its last edit`);
    expect(card).toContain(`ran no test, typecheck, lint or build`);
});
