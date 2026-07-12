---
name: signoz
description: Query observability (services, traces, logs, metrics) from a SigNoz instance via its API. Use when the user asks about app performance, errors, latency, or telemetry in SigNoz.
---

# SigNoz (connected)

Instance in `$SIGNOZ_URL`, API key in `$SIGNOZ_API_KEY`. Talk to `$SIGNOZ_URL` with `curl`.
Header: `-H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY"`.

- Confirm connectivity: `curl -s -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" "$SIGNOZ_URL/api/v1/version" | jq '.'`
- List instrumented services: `curl -s -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" "$SIGNOZ_URL/api/v1/services" | jq '.'`
- Query traces/logs/metrics: POST `$SIGNOZ_URL/api/v3/query_range` with a JSON builder query (start/end epoch-ms + a composite query). Ask the user which service/metric and time window, then build the body.

Notes: start with /api/v1/version to confirm the key + URL, then /api/v1/services, then query_range for detail. The query_range body is verbose — build it incrementally.
