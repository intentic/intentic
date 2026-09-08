// Marker for "leave the stored value alone"; distinct from empty or missing so a bypassed read fails loudly.
export const VAULTED = "__intentic_vaulted__";

/** Whether a value is the marker rather than a real credential. */
export const isVaulted = (value: unknown): boolean => value === VAULTED;
