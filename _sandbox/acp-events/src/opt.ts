/* Spread helper for optional fields: `...opt("key", value)` puts the key on the object only when the value is present. */
export const opt = <K extends PropertyKey, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
    // SAFETY: what is built is `{}` or `{ [key]: value }` with `value` present, the two shapes a type whose one key may be absent has.
    (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
