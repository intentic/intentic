// What base offers that head no longer does, as dotted paths; shared by the push gate and the commit drafter so both
// draw the same verdict. Growth never appears in the result; array elements match unordered, so a moved element passes.
// `description` is skipped only as a schema keyword, not when it names an actual field.

// JSON Schema keywords whose value maps NAME to schema; inside one a key is a field, elsewhere a keyword.
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

const dotted = (at, key) => (at === "" ? key : `${at}.${key}`);

// Every surface `base` offers that `head` no longer does, as dotted paths.
export const shrunkSurfaces = (base, head, at = "", out = [], named = true) => {
    if (Array.isArray(base) || Array.isArray(head)) {
        if (!Array.isArray(base) || !Array.isArray(head)) {
            out.push(at);
            return out;
        }
        for (const [index, item] of base.entries()) {
            const itemAt = typeof item === "object" && item !== null ? `${at}[${index}]` : `${at} ${JSON.stringify(item)}`;
            const offered = head.some((candidate) => shrunkSurfaces(item, candidate, itemAt, [], false).length === 0);
            if (!offered) {
                out.push(itemAt);
            }
        }
        return out;
    }
    if (typeof base !== "object" || base === null || typeof head !== "object" || head === null) {
        if (JSON.stringify(base) !== JSON.stringify(head)) {
            out.push(at);
        }
        return out;
    }
    for (const key of Object.keys(base)) {
        if (!named && key === "description") {
            continue;
        }
        if (key in head) {
            shrunkSurfaces(base[key], head[key], dotted(at, key), out, !named && NAME_MAPS.has(key));
        } else {
            out.push(dotted(at, key));
        }
    }
    return out;
};

// Same comparison over two lock-file texts; either side failing to parse yields no shrink rather than a throw.
export const lockShrinkage = (baseText, headText) => {
    try {
        return shrunkSurfaces(JSON.parse(baseText), JSON.parse(headText));
    } catch {
        return [];
    }
};
