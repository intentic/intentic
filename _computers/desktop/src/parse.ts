import type { WindowInfo } from "./types.js";

/* Turning what a platform's window lister prints into WindowInfo.
 *
 * Pure functions, apart from the rest of this package, because they are the only part of window enumeration that
 * can be tested without a desktop: the IO is `wmctrl` or PowerShell producing text, and the bugs live in reading
 * that text — a title containing spaces, a single window arriving as an object rather than an array, a hex id
 * where a decimal one is expected. Each of those has cost somebody an afternoon somewhere. */

/* `wmctrl -lGpx` prints fixed columns and then the title, which is everything left on the line:
 *
 *   0x03400007  0 4242   0    0    1920 1080 code.Code            hostname Some — Title — With Spaces
 *   ^id         ^d ^pid  ^x   ^y   ^w   ^h   ^class               ^host    ^title
 *
 * So the split is "nine fields, then the remainder" — never a plain whitespace split, which would truncate every
 * title at its first space. The class is `instance.Class`; the part after the dot is the one a person recognises
 * ("Code", "Google-chrome"), so that is what becomes `app`. */
export const parseWmctrl = (output: string, focusedId?: string): WindowInfo[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .flatMap((line) => {
            // Nine whitespace-delimited fields, then the title as EVERYTHING left — matched in one pattern rather
            // than split-and-rejoin, because the columns are padded with runs of spaces that a rejoin cannot
            // reproduce, and a title is far more likely to contain spaces than not.
            const fields = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
            if (fields === null) {
                return [];
            }
            const [, id, , , x, y, width, height, wmClass, , rawTitle] = fields;
            if (id === undefined || wmClass === undefined) {
                return [];
            }
            const title = (rawTitle ?? "").trim();
            const app = wmClass.includes(".") ? (wmClass.split(".").pop() ?? wmClass) : wmClass;
            return [
                {
                    id,
                    title,
                    app,
                    bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
                    // X11 ids come out of wmctrl as 0x0340_0007 and out of xdotool as decimal — compared as
                    // numbers so the two spellings of the same window are recognised as the same window.
                    focused: focusedId !== undefined && Number(id) === Number(focusedId),
                },
            ];
        });

interface SwayNode {
    readonly id?: number;
    readonly name?: string | null;
    readonly app_id?: string | null;
    readonly window_properties?: { readonly class?: string };
    readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focused?: boolean;
    readonly nodes?: readonly SwayNode[];
    readonly floating_nodes?: readonly SwayNode[];
}

/* sway (and other wlroots compositors that speak the i3 IPC) answers `swaymsg -t get_tree` with a nested tree of
 * outputs → workspaces → containers. A window is a leaf that has a name and a geometry; everything above it is
 * scaffolding. Recursion rather than a flat scan because the depth varies with how the user has split their
 * workspace, and floating windows hang off a different child list than tiled ones. */
const walkSwayNode = (node: SwayNode): WindowInfo[] => {
    const children = [...(node.nodes ?? []), ...(node.floating_nodes ?? [])];
    const descendants = children.flatMap(walkSwayNode);
    const name = node.name ?? "";
    const app = node.app_id ?? node.window_properties?.class ?? "";
    // A container with children is a split, not a window, however it is named.
    if (children.length > 0 || name === "" || node.rect === undefined || node.id === undefined) {
        return descendants;
    }
    return [
        {
            id: String(node.id),
            title: name,
            app: app === "" ? "unknown" : app,
            bounds: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height },
            focused: node.focused === true,
        },
        ...descendants,
    ];
};

export const parseSwayTree = (json: string): WindowInfo[] => {
    try {
        return walkSwayNode(JSON.parse(json) as SwayNode);
    } catch {
        return [];
    }
};

/* Windows' lister is a PowerShell pipeline into ConvertTo-Json, whose one infuriating habit is emitting a bare
 * OBJECT when the pipeline produced exactly one item, and an ARRAY otherwise. Rather than fight it with
 * `-AsArray` (PowerShell 7 only, and 5.1 is still what many machines have), both shapes are accepted here. */
export const parseWindowsJson = (json: string): WindowInfo[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
        const record = row as Record<string, unknown>;
        const id = record["id"];
        if (typeof id !== "string" || id === "" || id === "0") {
            return [];
        }
        return [
            {
                id,
                title: String(record["title"] ?? ""),
                app: String(record["app"] ?? "unknown"),
                bounds: {
                    x: Number(record["x"] ?? 0),
                    y: Number(record["y"] ?? 0),
                    width: Number(record["width"] ?? 0),
                    height: Number(record["height"] ?? 0),
                },
                focused: record["focused"] === true,
            },
        ];
    });
};

// Whether a launch target is something to OPEN (a URL, or a path that exists) rather than a program to run. The
// distinction decides between `xdg-open`/`Start-Process <url>` and spawning a command, and getting it wrong is
// the difference between the user's browser opening and a "command not found".
export const looksLikeUrl = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(www\.|mailto:)/i.test(target);
