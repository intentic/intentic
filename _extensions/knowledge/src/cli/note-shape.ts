/* The two rules `kb new` and `kb link` apply on the caller's behalf, separated from the command itself so they
 * can be tested without running a process, and so the command file stays a file that only ever runs. */

/* `--link works_on=Intentic` → the header field `works_on: ["[[Intentic]]"]`.
 *
 * The brackets are ADDED rather than asked for. A relationship written without them is an ordinary string that
 * the graph cannot see, and that failure is invisible: the note looks right, the field is there, and the note
 * simply has no connections. Making the caller remember a syntax whose omission is silent is how a knowledge
 * base fills up with facts nothing can reach. */
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

// A title as a filename. Deliberately lossy in one direction only: what comes out is always a safe path
// segment, and the title itself is kept in the header, so nothing about the note depends on reading it back.
export const slugify = (title: string): string =>
    title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "note";
