// Markup reading without a parser, shared by the kit's own checks (check/kit-decisions.mjs, check/extension.mjs) and the
// intentic repository's template gates (_tools/checks/lib/templates.mjs re-exports it), so an extension built outside the
// repository is judged by the same walk as the editor. Needs nothing installed: checks run before `pnpm install`.

// Blanks, not strips, `<script>`, `<style>` and `<!-- -->` regions so line numbers stay valid; each one's example
// markup would otherwise misreport as real usage.
const blanked = (m) => m.replace(/[^\n]/gu, ` `);
export const blank = (source) =>
    source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, blanked)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, blanked)
        .replace(/<!--[\s\S]*?-->/gu, blanked);

// A tag walk, not a parser: attribute values are consumed as units so a `>` inside `:class="{…}"` can't end a tag
// early. A generator, not a shared regex, since `/g` carries `lastIndex` and callers would fight over one cursor.
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;
export function* tags(scan, from = 0) {
    const walk = new RegExp(TAG.source, TAG.flags);
    walk.lastIndex = from;
    let match;
    while ((match = walk.exec(scan)) !== null) {
        const [, closing, name, attrs, selfClosing] = match;
        yield { closing, name, attrs, selfClosing, index: match.index, end: walk.lastIndex };
    }
}

/** Elements with no closing tag, so a tag walk must not push them onto its stack. */
export const VOID = new Set([`br`, `hr`, `img`, `input`, `source`]);

/** `path:line` for an offset into the blanked scan, which shares the source's newlines. */
export const at = (path, scan, index) => `${path}:${scan.slice(0, index).split(`\n`).length}`;

/** Both `class="…"` and `:class="…"`, joined: geometry hidden in a bound class is the same geometry. */
export const classesOf = (attrs) => [...attrs.matchAll(/:?class="([^"]*)"/gu)].map((m) => m[1]).join(` `);

// Turns punctuation into whitespace: a bound class is often an array of template literals, so its first class is
// preceded by a backtick, not a space, which a `(?:^|\s)`-anchored rule would otherwise miss.
export const classWordsOf = (attrs) =>
    classesOf(attrs)
        .replace(/[`',]/gu, ` `)
        .replace(/\s+/gu, ` `)
        .trim();
