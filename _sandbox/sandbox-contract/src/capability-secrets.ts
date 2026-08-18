/* THE ONE VALUE THAT MEANS "WHATEVER IS ALREADY STORED" — the rule both ends of the capability wire apply.
 *
 * A capability's credentials never reach a browser: the list route echoes the shape of a connection and drops
 * every secret in it, and the manifest on disk holds this marker where each value used to be (the vault keeps
 * the value itself). That is what makes a connection EDITABLE without being re-typed: a form that wants to
 * change a tunnel's routed networks sends this back in place of the pre-shared key it was never shown, and both
 * the write path and the storage layer read it as "leave that one alone".
 *
 * Deliberately not an empty string and not a dropped key. The entry still has to satisfy CapabilitySchema — a
 * connector's required token, an ssh key — and a reader that somehow bypasses rehydration must fail LOUDLY: a
 * service refusing this string is a clear auth error, where an empty value reads as "not configured yet" and a
 * missing key as a shape change.
 *
 * It lives in the contract rather than in the daemon's store because it is now spoken on the wire. The browser
 * has to be able to say it, the add route has to resolve it before a handler ever sees it, and the store has to
 * refuse to write it over a real value — three places, one spelling. */
export const VAULTED = "__intentic_vaulted__";

/** Whether a config value is the marker rather than a credential — the check, so the string is typed once. */
export const isVaulted = (value: unknown): boolean => value === VAULTED;
