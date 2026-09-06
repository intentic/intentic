/* Spread helper for optional fields: `...opt("key", value)` puts the key on the object only when the value is
 * present. The wire frames and SDK options are full of fields that must be ABSENT rather than undefined
 * (exactOptionalPropertyTypes, and stored transcripts that must not carry nulls), and the inline
 * `...(x !== undefined ? { k: x } : {})` idiom this replaces buried every frame's real shape under its
 * presence checks. */
export const opt = <K extends PropertyKey, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
    (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
