// Twelve lowercase hex characters, a gate applied before trusting an id off the wire (a hostname, a ticket, a path).
// Its own module so a browser bundle can take it without tunnel-ids.ts's node:crypto.
export const SANDBOX_ID = /^[0-9a-f]{12}$/;
