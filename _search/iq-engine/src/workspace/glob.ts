// Minimal glob → RegExp for scope filters (--glob/--not-glob, iq files --glob). Supports **, *, ?, [...] and
// {a,b} alternation over forward-slash relative paths. A glob without a slash matches against the basename-or-
// anywhere form (like ripgrep's -g), by prefixing **/.
export const globToRegExp = (glob: string): RegExp => {
    const pattern = glob.includes("/") ? glob.replace(/^\.\//, "") : `**/${glob}`;
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]!;
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // `**/` and `/**` cross directories; bare `**` too.
                re += "(?:.*)";
                i++;
                if (pattern[i + 1] === "/") {
                    i++;
                }
                continue;
            }
            re += "[^/]*";
            continue;
        }
        if (ch === "?") {
            re += "[^/]";
            continue;
        }
        if (ch === "[") {
            const end = pattern.indexOf("]", i + 1);
            if (end === -1) {
                re += "\\[";
                continue;
            }
            re += pattern.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === "{") {
            const end = pattern.indexOf("}", i + 1);
            if (end === -1) {
                re += "\\{";
                continue;
            }
            const alts = pattern
                .slice(i + 1, end)
                .split(",")
                .map((alt) =>
                    alt
                        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                        .replace(/\*/g, "[^/]*")
                        .replace(/\?/g, "[^/]"),
                );
            re += `(?:${alts.join("|")})`;
            i = end;
            continue;
        }
        re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
    // A trailing / means "the directory and everything under it".
    return new RegExp(pattern.endsWith("/") ? `^${re}.*$` : `^${re}$`);
};
