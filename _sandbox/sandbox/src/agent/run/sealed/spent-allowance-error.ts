/**
 * A sealed request refused for a spent allowance (`rate_limit`), in the provider's words, filed on the refusal ledger by
 * the time it is thrown (sealed-request.ts). A module of its own, as SealedDeadlineError's is, so the role ladder names
 * it at load without reaching into the request's module graph, which reaches back into the ladder.
 */
export class SpentAllowanceError extends Error {}
