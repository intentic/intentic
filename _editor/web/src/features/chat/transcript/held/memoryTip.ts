import type { Tip, TipRow } from "@intentic/ui";
import { formatFixed, formatPercent } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

/*
 * A low-memory hold's hover, as figures rather than the sandbox's sentence. The sentence is the daemon's own
 * (`judge` in @intentic/constants/memory-room), English on the wire and never translated, so what the reader gets is
 * its numbers under words in their own language: resident, swapped, the limit, what other work holds. Read from the
 * sentence because a row carries nothing else once a reload rebuilt it from the transcript; memoryTip.test.ts runs
 * the daemon's own `judge` so a change to its wording fails there, not silently here.
 */

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const ANY_NUMBER = String.raw`\d+(?:\.\d+)?`;

// In the order the card lists them, each with the phrase that names it in the daemon's sentence.
const FIGURES = [
    { label: () => t(`chat.chatHeld.memoryTip.resident`), pattern: new RegExp(`${NUMBER} GiB resident`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.swapped`), pattern: new RegExp(`${NUMBER} GiB swapped`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.used`), pattern: new RegExp(`${NUMBER} GiB of ${ANY_NUMBER} GiB used`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.limit`), pattern: new RegExp(`(?:against ${NUMBER} GiB|of ${NUMBER} GiB used)`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.machineFree`), pattern: new RegExp(`has ${NUMBER} GiB available`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.reserved`), pattern: new RegExp(`${NUMBER} GiB held`), unit: `gib` },
    { label: () => t(`chat.chatHeld.memoryTip.stalled`), pattern: new RegExp(`for ${NUMBER}% of the last`), unit: `percent` },
] as const;

// Whichever alternative matched: the limit is `against X GiB` in one phrasing and `of X GiB used` in the other.
const figureIn = (reading: string, pattern: RegExp): number | undefined => {
    const match = pattern.exec(reading);
    const found = match?.slice(1).find((group) => group !== undefined);
    return found === undefined ? undefined : Number(found);
};

/** The hold's figures as a card, or nothing when the sentence names none (the visible line already says "low"). */
export const memoryTip = (reading: string | undefined): Tip | undefined => {
    if (reading === undefined) {
        return undefined;
    }
    const rows: TipRow[] = FIGURES.flatMap(({ label, pattern, unit }) => {
        const value = figureIn(reading, pattern);
        if (value === undefined) {
            return [];
        }
        return [{ label: label(), value: unit === `gib` ? `${formatFixed(value, 1)} GiB` : formatPercent(value) }];
    });
    return rows.length === 0 ? undefined : { title: t(`chat.chatHeld.memoryTip.title`), tone: `warn`, rows };
};

/** The "send anyway" press's hover: that it starts now, and the one risk that runs. */
export const sendAnywayTip = (): Tip => ({ title: t(`chat.chatHeld.startsNow`), tone: `warn`, note: t(`chat.chatHeld.startsNowRisk`) });

/**
 * The hold's figures in a few characters, as the notice over the composer says them ("4.9/8.0 GiB"): what is in use
 * against the limit, or undefined when the sentence names neither (a stall names no ceiling), and the line says "low" alone.
 */
export const memoryShare = (reading: string | undefined): string | undefined => {
    if (reading === undefined) {
        return undefined;
    }
    const [resident, , used, limit] = FIGURES.slice(0, 4).map(({ pattern }) => figureIn(reading, pattern));
    const inUse = resident ?? used;
    return inUse === undefined || limit === undefined ? undefined : `${formatFixed(inUse, 1)}/${formatFixed(limit, 1)} GiB`;
};
