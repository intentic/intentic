// Fenced merge a migration writes memory with, the daemon-side sibling of the web's memoryImport.ts. Generalized to one
// fence id per block, so independent pieces (SOUL, memory, notes) can each be re-imported or removed alone. Replace in
// place if the fence exists, append if not; an unterminated block is replaced to end of file.

const startMarker = (id: string): string => `<!-- ${id}:start -->`;
const endMarker = (id: string): string => `<!-- ${id}:end -->`;

// `id` is the fence's name; `body` is the finished markdown block (heading included) — this frames it, it does not
// compose the content.
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
