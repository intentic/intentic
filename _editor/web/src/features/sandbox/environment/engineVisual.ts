import type { EngineId } from "@intentic/sandbox-contract/schemas/engines";
import type { IconName } from "@intentic/ui";

/* THE MARK ON AN ENGINE ROW, the same question the environment and skills lists already answer: which program is this, at a glance. */

export interface EngineVisual {
    readonly logo?: string;
    readonly icon: IconName;
}

const VISUALS: Record<EngineId, EngineVisual> = {
    claude: { logo: `claude`, icon: `sparkles` },
    codex: { icon: `terminal` },
    cursor: { logo: `cursor`, icon: `cpu` },
    devin: { logo: `devin`, icon: `robot` },
    // Simple Icons has Moonshot's mark; it has none for xAI, so Grok Build wears the terminal it runs in.
    "grok-build": { icon: `terminal` },
    kimi: { logo: `moonshotai`, icon: `terminal` },
    muse: { logo: `meta`, icon: `sparkles` },
    opencode: { icon: `code` },
    translator: { icon: `repeat` },
};

export const engineVisual = (id: EngineId): EngineVisual => VISUALS[id];
