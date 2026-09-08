import type { WindowInfo } from "./types.js";

// Turns platform window-lister output (wmctrl/PowerShell text or JSON) into WindowInfo. Pure functions, testable
// without a desktop.

// wmctrl -lGpx columns: nine fields, then the title is everything remaining on the line. `app` is the part of
// `instance.Class` after the dot.
export const parseWmctrl = (output: string, focusedId?: string): WindowInfo[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .flatMap((line) => {
            // One regex instead of split-and-rejoin: padded columns cannot be rejoined and titles often contain spaces.
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
                    // wmctrl ids are hex, xdotool ids are decimal; compared as numbers so both spellings match.
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

// get_tree is a nested tree; a window is a leaf with a name and geometry, everything above is scaffolding. Recurses
// since depth varies and floating windows are a separate child list.
const walkSwayNode = (node: SwayNode): WindowInfo[] => {
    const children = [...(node.nodes ?? []), ...(node.floating_nodes ?? [])];
    const descendants = children.flatMap(walkSwayNode);
    const name = node.name ?? "";
    const app = node.app_id ?? node.window_properties?.class ?? "";
    // A container with children is a split, not a window, regardless of its name.
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

// ConvertTo-Json emits a bare object for one item, an array otherwise; both shapes are accepted here instead of
// relying on -AsArray (PowerShell 7 only).
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

// Whether a launch target should be opened (a URL, or an existing path) rather than run as a command; picks between
// xdg-open/Start-Process and spawning it directly.
export const looksLikeUrl = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(www\.|mailto:)/i.test(target);
