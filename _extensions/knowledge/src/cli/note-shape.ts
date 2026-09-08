// Rules `kb new` and `kb link` apply on the caller's behalf, split out so they're testable without running a process
// and the command file only ever runs.

// `--link works_on=Intentic` becomes the header field `works_on: ["[[Intentic]]"]`; brackets are added since a plain
// string is invisible to the graph, and the note silently gains no connection.
export const linkFields = (pairs: readonly string[]): Map<string, string[]> => {
    const fields = new Map<string, string[]>();
    for (const pair of pairs) {
        const cut = pair.indexOf("=");
        if (cut <= 0) {
            continue;
        }
        const relation = pair.slice(0, cut).trim();
        const target = pair.slice(cut + 1).trim();
        if (relation === "" || target === "") {
            continue;
        }
        fields.set(relation, [...(fields.get(relation) ?? []), wikiLink(target)]);
    }
    return fields;
};

export const wikiLink = (target: string): string => (target.startsWith("[[") ? target : `[[${target}]]`);

// Title as a filename, lossy in one direction only: the slug is a safe path segment, and the title itself stays in the
// header, so nothing reads the slug back.
export const slugify = (title: string): string =>
    title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "note";
