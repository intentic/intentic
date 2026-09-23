// A message catalog's JSON, or the one-line finding that names why `path` cannot be read as one.
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/m;

export const parseCatalog = (path, text) => {
    const marker = CONFLICT_MARKER.exec(text);
    if (marker !== null) {
        return { problem: `${path} has unresolved merge-conflict markers (line ${text.slice(0, marker.index).split("\n").length})` };
    }
    try {
        return { tree: JSON.parse(text) };
    } catch (error) {
        return { problem: `${path} is not valid JSON: ${error.message}` };
    }
};
