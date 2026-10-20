#!/usr/bin/env node
// A kit primitive drawn by hand. Each of these was hand-drawn in views before the kit had it, and drawn by hand again
// after, by a view that did not know: so the copy, not the primitive, decided how it looked and behaved there. Refuses:
// - `label`: the section label's look (uppercase, tracked) on any element but a table's column head. A label over a
//   part is <SectionHeader> (`density="dense"` in a menu, a drawer or a card) or <Section :label>; words in a row take
//   no uppercase. Before this, a menu's group heading, a drawer's sub-label and a card's eyebrow were each a `<span>` or
//   a `<div>` with its own size, weight, ink and tracking, and nothing read anything but `<h1>`–`<h6>`.
// - `tabs`: a `role="tablist"` or a `ui.tab()` outside <SegmentedControl>, which owns the roving tab stop, the arrow
//   keys and the selected mark.
// - `search`: the search dress (`ui-search`, `ui-search-band`, `ui-search-icon`), a `type="search"` field, or a field a
//   magnifier glyph leads, outside <SearchBar>.
// - `open`: the open row's wash (`ui-row-open`) outside <DisclosureRow>.
// The rules are lib/kit-decisions.mjs's `substituteFindings`, where their tests read them. A place whose own shape the
// primitive cannot draw says why with `<!-- allow(substitutes): <reason> -->` above the tag.
import { substituteFindings } from "../../_shared/extension-ui/check/kit-decisions.mjs";
import { at, blank, excusedAt, finishFindings, templateSource, templatesUnder } from "./lib/templates.mjs";

const tracked = templatesUnder(`_editor/web/src`, `_editor/desktop-app/src`, `_editor/ui/src`, `_shared/extension-ui/src`, `_extensions`);
const findings = [];
for (const path of tracked) {
    const source = templateSource(path);
    const scan = blank(source);
    for (const { index, why } of substituteFindings(path, scan)) {
        if (!excusedAt(source, scan, index, `substitutes`)) {
            findings.push({ at: at(path, scan, index), why });
        }
    }
}

finishFindings(
    findings,
    `with kit substitutes. A section label, a tab strip, a search field and an open row are each the kit's, drawn by one primitive.`,
    `${tracked.length} templates: every section label, tab strip, search field and open row is the kit's own`,
);
