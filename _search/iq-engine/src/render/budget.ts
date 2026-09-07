// The budget unit, from @intentic/base so iq, fileq, webq and the daemon's savings report all count the same
// way. Re-exported rather than imported at each site: everything in here that spends a budget reads it from
// this module, and the property tests assert the rendered output never exceeds a budget under this estimate.
export { estimateTokens } from "@intentic/base/format";
