// The one error an arrival can fail with that is the caller's fault: unifies four readers' malformed-file errors into
// one 400, caught once by the arrival routes.
// Lives at the root of src/, above both portability/ and migrations/, so raising it never imports one subsystem's
// surface into the other.
export class ArrivalFormatError extends Error {}

// A held plan that no longer matches: the token names an artifact this daemon has already consumed or forgotten across
// a restart.
// Distinct from ArrivalFormatError: the file was fine, the preview went stale, so the route answers 409 and the card
// re-reads.
export class ArrivalStaleError extends Error {}
