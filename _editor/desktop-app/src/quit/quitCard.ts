import { invoke } from "@tauri-apps/api/core";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// THE QUIT CARD, IN THE READER'S WORDS (windows/quit_card.rs gathers the facts, QuitCard.vue draws them). Every question a
// close or a quit asks is on this one card: what a quit would interrupt, each a row with what quitting does to it, and
// the answers as whole outcomes pressed once. Pure, so the words for every card are tested without a window.

/** What a quit does to the sandboxes on this computer (quit_card.rs `Sandboxes`). */
export type SandboxesAtQuit = `idle` | `keep` | `stop` | `ask`;

export type WorkKind = `setup` | `power` | `update` | `remove` | `fix` | `move` | `sync` | `system` | `drive` | `pair` | `bringBack` | `other`;

export interface Work {
    readonly kind: WorkKind;
    /** The sandbox it is about, for the kinds about one. */
    readonly sandbox?: string;
}

/** What the app hands the card (quit_card.rs `Card`), on `window.__INTENTIC_QUIT_CARD__` before the page runs. */
export interface QuitCardFacts {
    /** The ×'s question: keeping the app in the tray is one of the answers. */
    readonly fromClose: boolean;
    readonly unsaved: number;
    readonly agents: number;
    readonly work: readonly Work[];
    /** A setup is moving this PC's sandboxes, and a quit stops the move. */
    readonly moving: boolean;
    readonly sandboxes: SandboxesAtQuit;
}

/** How much a fact costs: lost, stopped, or nothing (it carries on). */
export type FactTone = `danger` | `warning` | `neutral`;

/** One thing a quit would interrupt, and what quitting does to it. */
export interface Fact {
    readonly key: string;
    readonly icon: IconName;
    readonly tone: FactTone;
    readonly title: string;
    /** What quitting does to it. */
    readonly outcome: string;
}

/** What an answer tells the app (quit_card.rs `Choice`); `back` is the card closing, which changes nothing. */
export type AnswerKind = `tray` | `wait` | `now` | `back`;

/** One answer: a whole outcome, pressed once. */
export interface Choice {
    readonly key: string;
    readonly answer: AnswerKind;
    /** For the sandboxes question: whether they keep running after the quit. */
    readonly keepSandboxes?: boolean;
    readonly icon: IconName;
    /** `danger` when the press loses something. */
    readonly danger: boolean;
    readonly title: string;
    readonly hint: string;
    /** A second, quieter line (where the tray icon is). */
    readonly note: string | undefined;
}

export interface CardView {
    readonly title: string;
    readonly lead: string | undefined;
    readonly facts: readonly Fact[];
    /** The first is the recoverable one, focused so Return picks it. */
    readonly choices: readonly Choice[];
    /** "Always do this: don't ask again" applies. */
    readonly canRemember: boolean;
    /** The sandboxes question is asked, and its answer becomes the setting. */
    readonly asksSandboxes: boolean;
}

declare global {
    interface Window {
        /* What a close or a quit would interrupt, set by the app before this page runs (quit_card.rs `ask`). */
        __INTENTIC_QUIT_CARD__?: QuitCardFacts | null;
    }
}

/** The facts the app put on the window; a page opened any other way (a preview) draws the ×'s plain question. */
export const readCard = (): QuitCardFacts =>
    window.__INTENTIC_QUIT_CARD__ ?? { fromClose: true, unsaved: 0, agents: 0, work: [], moving: false, sandboxes: `keep` };

/** The answer, to the one command the card may call. Closing the card instead is the cancel. */
export const quitCardAnswer = (answer: Exclude<AnswerKind, `back`>, keepSandboxes: boolean | undefined, remember: boolean): Promise<void> =>
    invoke(`quit_card_answer`, { answer: { choice: answer, keepSandboxes, remember } });

const busyOf = (card: QuitCardFacts): boolean => card.agents > 0 || card.work.length > 0 || card.moving;

/* WHAT EACH PIECE OF WORK IS CALLED, and its icon. A setup stops with the app; everything else carries on by itself. */

const WORK_ICON = {
    setup: `cloud-download`,
    power: `bolt`,
    update: `refresh`,
    remove: `trash`,
    fix: `wrench`,
    move: `boxes`,
    sync: `sync`,
    system: `desktop`,
    drive: `database`,
    pair: `link`,
    bringBack: `folder-open`,
    other: `clock`,
} as const satisfies Record<WorkKind, IconName>;

const workTitle = ({ kind, sandbox }: Work): string => {
    const name = sandbox ?? ``;
    const named = name.length > 0;
    switch (kind) {
        case `setup`:
            return t(`desktop.quitCard.fact.setup`);
        case `power`:
            return named ? t(`desktop.quitCard.fact.power`, { name }) : t(`desktop.quitCard.fact.powerAny`);
        case `update`:
            return named ? t(`desktop.quitCard.fact.update`, { name }) : t(`desktop.quitCard.fact.updateAny`);
        case `remove`:
            return named ? t(`desktop.quitCard.fact.remove`, { name }) : t(`desktop.quitCard.fact.removeAny`);
        case `fix`:
            return named ? t(`desktop.quitCard.fact.fix`, { name }) : t(`desktop.quitCard.fact.fixAny`);
        case `move`:
            return t(`desktop.quitCard.fact.move`);
        case `sync`:
            return t(`desktop.quitCard.fact.sync`);
        case `system`:
            return t(`desktop.quitCard.fact.system`);
        case `drive`:
            return t(`desktop.quitCard.fact.drive`);
        case `pair`:
            return t(`desktop.quitCard.fact.pair`);
        case `bringBack`:
            return t(`desktop.quitCard.fact.bringBack`);
        case `other`:
            return t(`desktop.quitCard.fact.other`);
    }
};

/** What a quit would interrupt, costliest first: what is lost, then what stops, then what carries on. */
const factsOf = (card: QuitCardFacts): Fact[] => {
    const facts: Fact[] = [];
    if (card.unsaved > 0) {
        facts.push({
            key: `unsaved`,
            icon: `file-edit`,
            tone: `danger`,
            title: t(`desktop.quitCard.fact.unsaved`, { count: card.unsaved }, card.unsaved),
            outcome: t(`desktop.quitCard.fact.unsavedThen`),
        });
    }
    if (card.moving) {
        facts.push({ key: `moving`, icon: `boxes`, tone: `warning`, title: t(`desktop.quitCard.fact.moving`), outcome: t(`desktop.quitCard.fact.movingThen`) });
    }
    if (card.agents > 0) {
        facts.push({
            key: `agents`,
            icon: `robot`,
            tone: `warning`,
            title: t(`desktop.quitCard.fact.agents`, { count: card.agents }, card.agents),
            outcome: t(`desktop.quitCard.fact.agentsThen`, card.agents),
        });
    }
    const stops = card.work.filter((work) => work.kind === `setup`);
    const carries = card.work.filter((work) => work.kind !== `setup`);
    // A setup that is moving sandboxes is said once, as the move.
    if (stops.length > 0 && !card.moving) {
        facts.push({ key: `setup`, icon: WORK_ICON.setup, tone: `warning`, title: workTitle(stops[0]!), outcome: t(`desktop.quitCard.fact.setupThen`) });
    }
    carries.forEach((work, index) => {
        facts.push({ key: `work-${index}`, icon: WORK_ICON[work.kind], tone: `neutral`, title: workTitle(work), outcome: t(`desktop.quitCard.fact.carriesOn`) });
    });
    return facts;
};

const trayChoice = (busy: boolean, onWindows: boolean): Choice => ({
    key: `tray`,
    answer: `tray`,
    // An arrow into a tray: where the app goes.
    icon: `download`,
    danger: false,
    title: t(`desktop.quitCard.tray.title`),
    hint: busy ? t(`desktop.quitCard.tray.hintBusy`) : t(`desktop.quitCard.tray.hint`),
    note: onWindows ? t(`desktop.quitCard.tray.where`) : undefined,
});

const quitHint = (sandboxes: SandboxesAtQuit): string => {
    switch (sandboxes) {
        case `stop`:
            return t(`desktop.quitCard.quit.hintStop`);
        case `keep`:
            return t(`desktop.quitCard.quit.hintKeep`);
        default:
            return t(`desktop.quitCard.quit.hint`);
    }
};

/** The answers, by what the card asks: the recoverable one first. */
const choicesOf = (card: QuitCardFacts, onWindows: boolean): Choice[] => {
    const busy = busyOf(card);
    const loses = card.unsaved > 0 || card.moving;
    const choices: Choice[] = card.fromClose ? [trayChoice(busy, onWindows)] : [];
    if (busy) {
        choices.push(
            { key: `wait`, answer: `wait`, icon: `clock`, danger: false, title: t(`desktop.quitCard.wait.title`), hint: t(`desktop.quitCard.wait.hint`), note: undefined },
            { key: `now`, answer: `now`, icon: `sign-out`, danger: loses, title: t(`desktop.quitCard.now.title`), hint: t(`desktop.quitCard.now.hint`), note: undefined },
        );
    } else if (card.sandboxes === `ask`) {
        choices.push(
            {
                key: `keep`,
                answer: `now`,
                keepSandboxes: true,
                icon: `cloud`,
                danger: false,
                title: card.fromClose ? t(`desktop.quitCard.keep.titleQuit`) : t(`desktop.quitCard.keep.title`),
                hint: t(`desktop.quitCard.keep.hint`),
                note: undefined,
            },
            {
                key: `stop`,
                answer: `now`,
                keepSandboxes: false,
                icon: `stop`,
                danger: false,
                title: card.fromClose ? t(`desktop.quitCard.stop.titleQuit`) : t(`desktop.quitCard.stop.title`),
                hint: t(`desktop.quitCard.stop.hint`),
                note: undefined,
            },
        );
    } else if (card.unsaved > 0) {
        if (!card.fromClose) {
            choices.push({ key: `back`, answer: `back`, icon: `arrow-left`, danger: false, title: t(`desktop.quitCard.back.title`), hint: t(`desktop.quitCard.back.hint`), note: undefined });
        }
        choices.push({ key: `discard`, answer: `now`, icon: `sign-out`, danger: true, title: t(`desktop.quitCard.discard.title`), hint: t(`desktop.quitCard.discard.hint`), note: undefined });
    } else {
        choices.push({ key: `quit`, answer: `now`, icon: `sign-out`, danger: false, title: t(`desktop.quitCard.quit.title`), hint: quitHint(card.sandboxes), note: undefined });
    }
    return choices;
};

const leadOf = (card: QuitCardFacts): string | undefined => {
    if (busyOf(card)) {
        return t(`desktop.quitCard.lead.busy`);
    }
    if (card.unsaved > 0) {
        return t(`desktop.quitCard.lead.unsaved`);
    }
    if (card.sandboxes === `ask`) {
        return card.fromClose ? t(`desktop.quitCard.lead.sandboxesClose`) : t(`desktop.quitCard.lead.sandboxes`);
    }
    return undefined;
};

export const cardView = (card: QuitCardFacts, onWindows: boolean): CardView => {
    return {
        title: card.fromClose ? t(`desktop.quitCard.title.close`) : t(`desktop.quitCard.title.quit`),
        lead: leadOf(card),
        facts: factsOf(card),
        choices: choicesOf(card, onWindows),
        // The ×'s answer is always worth keeping; the one about work under way only where a quit loses nothing.
        canRemember: card.fromClose || (busyOf(card) && card.unsaved === 0 && !card.moving),
        asksSandboxes: card.sandboxes === `ask` && !busyOf(card) && card.unsaved === 0,
    };
};
