import type { EngineId } from "@intentic-app/api-contract";
import type { IconName } from "@intentic/ui";

/* THE MARK ON AN ENGINE ROW, the same question the environment and skills lists already answer: which program is
 * this, at a glance, without reading five similar names down a column. */

export interface EngineVisual {
    readonly logo?: string;
    readonly icon: IconName;
}

const VISUALS: Record<EngineId, EngineVisual> = {
    claude: { logo: `claude`, icon: `sparkles` },
    codex: { icon: `terminal` },
    cursor: { logo: `cursor`, icon: `cpu` },
    opencode: { icon: `code` },
    translator: { icon: `repeat` },
};

export const engineVisual = (id: EngineId): EngineVisual => VISUALS[id];
