/* THE FENCED MERGE a migration writes memory with, the daemon-side sibling of the web's memoryImport
 * (`_editor/web/src/composables/extensions/memoryImport.ts`), generalized over the fence id.
 *
 * Why a fence id per BLOCK rather than that module's single fixed pair: a migration lands several independent
 * pieces (the SOUL file, the memory files, the operating notes), each of which the owner may re-import or
 * remove on its own, and the generic paste importer must keep owning its own block beside them. Same
 * semantics otherwise, deliberately: replace-in-place when the fence exists, append when it does not, hand-
 * written text around the block preserved, an unterminated block tolerated by replacing to end of file. */

const startMarker = (id: string): string => `<!-- ${id}:start -->`;
const endMarker = (id: string): string => `<!-- ${id}:end -->`;

// `id` is the fence's name (e.g. `intentic:imported-hermes:soul`); `body` is the finished markdown block,
// heading included, the merge frames, it does not compose.
export const mergeFenced = (existing: string, id: string, body: string): string => {
    const block = `${startMarker(id)}\n${body.trim()}\n${endMarker(id)}`;
    const start = existing.indexOf(startMarker(id));
    if (start === -1) {
        return existing.trim() === "" ? `${block}\n` : `${existing.trimEnd()}\n\n${block}\n`;
    }
    const endIdx = existing.indexOf(endMarker(id));
    const end = endIdx === -1 ? existing.length : endIdx + endMarker(id).length;
    return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
};
