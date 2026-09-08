// Correlates a browser call to the daemon request that served it; a token only, never a security boundary.
export const REQUEST_ID_HEADER = "x-intentic-request-id";

// Confirms daemon CORS accepts this header before sending; no evidence here means don't send, unlike supportsRoute.
export const REQUEST_ID_EVIDENCE_ROUTE = "logs.report";
