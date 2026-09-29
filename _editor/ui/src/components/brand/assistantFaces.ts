/** Illustrated Khmer companions. Color, expression and accessory belong to each complete character. */
export const ASSISTANT_CHARACTERS = {
    keeper: { name: `Keeper`, detail: `Sandstone · a warm welcome`, src: new URL(`./assistants/keeper.webp`, import.meta.url).href },
    scholar: { name: `Scholar`, detail: `Lavender · curious eyes`, src: new URL(`./assistants/scholar.webp`, import.meta.url).href },
    builder: { name: `Builder`, detail: `Sage · ready to make`, src: new URL(`./assistants/builder.webp`, import.meta.url).href },
    scribe: { name: `Scribe`, detail: `Rose · a way with words`, src: new URL(`./assistants/scribe.webp`, import.meta.url).href },
    scout: { name: `Scout`, detail: `Sky · a closer look`, src: new URL(`./assistants/scout.webp`, import.meta.url).href },
    muse: { name: `Muse`, detail: `Peach · a fresh idea`, src: new URL(`./assistants/muse.webp`, import.meta.url).href },
    gardener: { name: `Gardener`, detail: `Moss · room to grow`, src: new URL(`./assistants/gardener.webp`, import.meta.url).href },
    navigator: { name: `Navigator`, detail: `Periwinkle · a clear direction`, src: new URL(`./assistants/navigator.webp`, import.meta.url).href },
} as const;

export type AssistantCharacter = keyof typeof ASSISTANT_CHARACTERS;
const characters = Object.keys(ASSISTANT_CHARACTERS) as AssistantCharacter[];

/** A stable character and independent motion phase, selected without random values or timers. */
export function assistantFace(seed: string) {
    let state = 0x81_1c_9d_c5;
    for (const char of seed) {
        state = Math.imul(state ^ char.codePointAt(0)!, 0x01_00_01_93) >>> 0;
    }
    if (state === 0) {
        state = 0x9e_37_79_b9;
    }
    const next = (): number => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    return {
        character: characters[next() % characters.length]!,
        duration: 5.5 + (next() % 25) / 10,
        delay: -(next() % 100) / 10,
    };
}
