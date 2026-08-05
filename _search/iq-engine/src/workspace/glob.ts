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
                // `**` crosses directories — but only WHOLE ones. A globstar before "api" means "an api
                // directory anywhere", not "anything ending in api": as `.*` it also matched `_apps/napi/x.ts`,
                // and since the search box's file filter puts a globstar in front of every name it is typed,
                // that was a directory nobody asked for in most of its results. Followed by a slash it consumes
                // zero or more COMPLETE segments (and may consume none); standing at the end it is the rest of
                // the path. Same rule as VSCode's glob and ripgrep's.
                i++;
                if (pattern[i + 1] === "/") {
                    re += "(?:[^/]+/)*";
                    i++;
                    continue;
                }
                re += ".*";
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
