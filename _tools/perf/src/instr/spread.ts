/** Range of repeated counts of one thing, and that range as a share of the smallest. */
export const spread = (values: readonly number[]): { readonly min: number; readonly max: number; readonly relative: number } => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, relative: min === 0 ? 0 : (max - min) / min };
};
