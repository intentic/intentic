// How a model id reads when no catalog names it, the same way in the daemon's catalogs and the app's labels: a vendor
// that publishes a name always wins, and this is the one rule for every id that has none.

// Ids whose case is the vendor's, not English's. Title-casing these reads as a typo in a picker row.
const ACRONYMS = new Set(["gpt", "oss", "api"]);

// A release stamp (`-20251001`, `-2025-10-01`) names a build, not the model a person picked.
const DATE_STAMP = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

// A version component spelled as its own segment (`opus-5-5`); longer runs of digits are builds, not versions.
const VERSION_PART = /^\d{1,2}$/;

const titled = (token: string): string => (ACRONYMS.has(token.toLowerCase()) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1));

/** Raw model id → display label: `claude-opus-5-5` → "Claude Opus 5.5", `gpt-5-codex` → "GPT 5 Codex". */
export const humanizeModelId = (id: string): string => {
    const words: string[] = [];
    let previousVersion = false;
    for (const token of id.replace(DATE_STAMP, "").split("-")) {
        const version = VERSION_PART.test(token);
        if (version && previousVersion) {
            words[words.length - 1] = `${words.at(-1)}.${token}`;
        } else if (token !== "") {
            words.push(titled(token));
        }
        previousVersion = version;
    }
    return words.join(" ");
};
