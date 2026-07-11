// Deep-clone a config object with the given dotted paths replaced by "***", so it's safe to log at
// startup. Mirrors the mask() helper the larger repos keep in a shared backend lib.
export const mask = <T>(value: T, secretPaths: string[]): T => {
    const clone = structuredClone(value) as Record<string, unknown>;
    for (const path of secretPaths) {
        const segments = path.split(`.`);
        let cursor: Record<string, unknown> | undefined = clone;
        for (let i = 0; i < segments.length - 1; i++) {
            const key = segments[i];
            if (key === undefined) {
                break;
            }
            const next: unknown = cursor?.[key];
            cursor = typeof next === `object` && next !== null ? (next as Record<string, unknown>) : undefined;
        }
        const leaf = segments.at(-1);
        if (cursor && leaf !== undefined && cursor[leaf] !== undefined && cursor[leaf] !== ``) {
            cursor[leaf] = `***`;
        }
    }
    return clone as T;
};
