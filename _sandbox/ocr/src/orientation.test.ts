import type { OcrLine } from "./paddle-ocr.js";
import { keptReading } from "./paddle-ocr-engine.js";

// Which way up a picture is read once the upright reading has not settled. The readings are the ones measured: a page on
// its head, and a phone photo whose line the detector half found.

const line = (text: string, score: number): OcrLine => ({
    text,
    score,
    corners: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
    ],
    chars: [],
    column: 0.1,
    vertical: false,
});

test("a page on its head is kept the way it reads, once turned over it reads more and reads it surely", () => {
    const upright = [line("so] ;", 0.58), line("ʇɐ 0z", 0.81)];
    const turned = [line("Klient numer 4815162342", 0.99), line("Faktura z dnia 12.03.2026", 0.99)];
    expect(keptReading(upright, turned)).toBe(turned);
});

test("a reading upside down that is mostly unsure never displaces the upright one, however many characters it has", () => {
    const upright = [line("Faktura", 1)];
    const turned = [line("815123342", 0.78), line("03.2026", 0.93), line("dup", 0.63), line("こT", 0.59)];
    expect(keptReading(upright, turned)).toBe(upright);
});

test("with no more sure characters turned over, the upright reading stands", () => {
    const upright = [line("Total 120,00", 0.97)];
    const turned = [line("00", 0.99)];
    expect(keptReading(upright, turned)).toBe(upright);
});
