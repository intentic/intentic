// The site's ornaments and the app's provider marks, read from the modules that own them, for every README picture.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

export const REPO = repoRoot(import.meta.url);
export const FONTS = join(REPO, "_editor/web/public/fonts");
export const PLATES = join(REPO, "_site/site/src/assets/plate");

// The ornaments live in a TypeScript module the site compiles; read as text, the way scripts/lotus.mjs reads them.
const ORNAMENTS = readFileSync(join(REPO, "_site/site/src/components/ornaments.ts"), "utf8");
const ornament = (name) => {
    const body = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`, "u").exec(ORNAMENTS)?.[1];
    if (body === undefined) {
        throw new Error(`ornaments.ts no longer exports ${name}`);
    }
    return body;
};
const LOTUS_PETALS = ornament("LOTUS_PETALS");
export const LOTUS = `<svg viewBox="0 -1.3 32 32" fill="currentColor" aria-hidden="true">${LOTUS_PETALS}</svg>`;
export const CORNER = ornament("CORNER");
export const LOZENGE = ornament("LOZENGE");

// The provider marks the app draws (24x24, currentColor), read from the same shared module the chat and the site use.
const LOGOS = readFileSync(join(REPO, "_tools/constants/src/provider-logos.ts"), "utf8");
export const providerMark = (brand) => {
    const path = new RegExp(`\\n\\s+${brand}: \`([^\`]+)\``, "u").exec(LOGOS)?.[1];
    if (path === undefined) {
        throw new Error(`provider-logos.ts has no mark for ${brand}`);
    }
    const rule = brand === "grok" || brand === "zai" ? ` fill-rule="evenodd"` : "";
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"${rule}/></svg>`;
};

/** The four turned corners of a carved frame. */
export const corners = () => ["tl", "tr", "bl", "br"].map((at) => `<i class="corner ${at}">${CORNER}</i>`).join("");
