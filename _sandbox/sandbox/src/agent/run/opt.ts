/* Spread helper for optional fields: `...opt("key", value)` puts the key on the object only when the value is present. */
export const opt = <K extends PropertyKey, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
    (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
