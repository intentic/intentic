/* The thrown thing's message, for the places that need a STRING rather than something to show a person: a log
 * line, an IPC reply's `error` field, a status row's detail. `instanceof Error ? error.message : String(error)`
 * was the single most repeated expression in the product, over a hundred and fifty copies, and it is here so the
 * next one reads as a name rather than a ternary. Anything a person reads still goes through the caller's own
 * sentence (the web's `noticeFrom`); this is the evidence under it, not the headline. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
