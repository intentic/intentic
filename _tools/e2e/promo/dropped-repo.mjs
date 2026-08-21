// The repository the video drags in. Written to disk at record time rather than committed, because the drop is a
// real one: Chromium hands the page actual FileSystemEntry roots for this directory, the app's own walker recurses
// it, and the fixture daemon writes what arrives. So the tree the viewer sees grow is the tree that is here.
//
// Deliberately a Go service: `acme-shop` already has a TypeScript api and web, a third language says "any repo",
// and no package.json means the upload queue never offers to install dependencies: a subprocess the recorded
// workspace has no honest answer for. Kept under 20 files so the queue takes its per-file XHR path (the one the
// demo's transport shim serves) instead of streaming a tar.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES = {
    "README.md": `# checkout-worker

Drains the Stripe webhook queue and reconciles orders against the API.

    go run ./cmd/worker
`,
    "go.mod": `module github.com/acme/checkout-worker

go 1.23

require (
\tgithub.com/jackc/pgx/v5 v5.6.0
\tgithub.com/stripe/stripe-go/v79 v79.9.0
)
`,
    "cmd/worker/main.go": `package main

import (
\t"context"
\t"log/slog"
\t"os"
\t"os/signal"
\t"syscall"

\t"github.com/acme/checkout-worker/internal/queue"
)

func main() {
\tctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
\tdefer stop()

\tworker, err := queue.Open(ctx, os.Getenv("DATABASE_URL"))
\tif err != nil {
\t\tslog.Error("open queue", "err", err)
\t\tos.Exit(1)
\t}
\tdefer worker.Close()

\tif err := worker.Drain(ctx); err != nil {
\t\tslog.Error("drain", "err", err)
\t\tos.Exit(1)
\t}
}
`,
    "internal/queue/queue.go": `package queue

import (
\t"context"
\t"fmt"
\t"time"

\t"github.com/jackc/pgx/v5/pgxpool"
)

// Worker leases webhook rows and hands each to a handler exactly once.
type Worker struct {
\tpool  *pgxpool.Pool
\tlease time.Duration
}

func Open(ctx context.Context, dsn string) (*Worker, error) {
\tpool, err := pgxpool.New(ctx, dsn)
\tif err != nil {
\t\treturn nil, fmt.Errorf("connect: %w", err)
\t}
\treturn &Worker{pool: pool, lease: 30 * time.Second}, nil
}

func (w *Worker) Close() { w.pool.Close() }
`,
    "internal/queue/drain.go": `package queue

import (
\t"context"
\t"log/slog"
\t"time"
)

const batchSize = 64

// Drain leases a batch, dispatches it, and acknowledges what succeeded. It returns only when ctx is done, so a
// deploy that stops the pod finishes the batch in flight instead of dropping it.
func (w *Worker) Drain(ctx context.Context) error {
\tticker := time.NewTicker(time.Second)
\tdefer ticker.Stop()

\tfor {
\t\tselect {
\t\tcase <-ctx.Done():
\t\t\treturn nil
\t\tcase <-ticker.C:
\t\t\tevents, err := w.lease(ctx, batchSize)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tfor _, event := range events {
\t\t\t\tif err := w.dispatch(ctx, event); err != nil {
\t\t\t\t\tslog.Warn("dispatch failed", "event", event.ID, "err", err)
\t\t\t\t\tcontinue
\t\t\t\t}
\t\t\t\tw.ack(ctx, event.ID)
\t\t\t}
\t\t}
\t}
}
`,
    "internal/queue/lease.go":
        `package queue

import "context"

type Event struct {
\tID   string
\tKind string
\tBody []byte
}

const leaseSQL = ` +
        "`" +
        `
UPDATE webhook_events
   SET leased_until = now() + $2
 WHERE id IN (SELECT id FROM webhook_events
               WHERE processed_at IS NULL AND leased_until < now()
               ORDER BY received_at LIMIT $1
               FOR UPDATE SKIP LOCKED)
RETURNING id, kind, body` +
        "`" +
        `

func (w *Worker) lease(ctx context.Context, limit int) ([]Event, error) {
\trows, err := w.pool.Query(ctx, leaseSQL, limit, w.lease)
\tif err != nil {
\t\treturn nil, err
\t}
\tdefer rows.Close()

\tvar events []Event
\tfor rows.Next() {
\t\tvar event Event
\t\tif err := rows.Scan(&event.ID, &event.Kind, &event.Body); err != nil {
\t\t\treturn nil, err
\t\t}
\t\tevents = append(events, event)
\t}
\treturn events, rows.Err()
}
`,
    "internal/queue/dispatch.go":
        `package queue

import (
\t"context"
\t"encoding/json"
\t"fmt"
)

func (w *Worker) dispatch(ctx context.Context, event Event) error {
\tswitch event.Kind {
\tcase "checkout.session.completed":
\t\tvar session struct {
\t\t\tID       string ` +
        '`json:"id"`' +
        `
\t\t\tCustomer string ` +
        '`json:"customer"`' +
        `
\t\t}
\t\tif err := json.Unmarshal(event.Body, &session); err != nil {
\t\t\treturn fmt.Errorf("decode session: %w", err)
\t\t}
\t\treturn w.fulfil(ctx, session.ID, session.Customer)
\tcase "charge.refunded":
\t\treturn w.refund(ctx, event)
\tdefault:
\t\treturn nil
\t}
}
`,
    "internal/queue/ack.go":
        `package queue

import (
\t"context"
\t"log/slog"
)

func (w *Worker) ack(ctx context.Context, id string) {
\tif _, err := w.pool.Exec(ctx, ` +
        "`UPDATE webhook_events SET processed_at = now() WHERE id = $1`" +
        `, id); err != nil {
\t\tslog.Error("ack failed", "event", id, "err", err)
\t}
}
`,
    "internal/orders/fulfil.go": `package orders

import "context"

// Fulfil marks the order paid and releases it to the warehouse feed. Idempotent: a webhook Stripe retries twice
// must not ship twice.
func Fulfil(ctx context.Context, sessionID, customer string) error {
\treturn nil
}
`,
    "internal/orders/refund.go": `package orders

import "context"

func Refund(ctx context.Context, chargeID string) error {
\treturn nil
}
`,
    "internal/stripe/client.go": `package stripe

import (
\t"os"

\tstripe "github.com/stripe/stripe-go/v79"
\t"github.com/stripe/stripe-go/v79/client"
)

func New() *client.API {
\tapi := &client.API{}
\tapi.Init(os.Getenv("STRIPE_SECRET_KEY"), nil)
\tstripe.EnableTelemetry = false
\treturn api
}
`,
    "internal/stripe/verify.go": `package stripe

import (
\t"net/http"
\t"os"

\t"github.com/stripe/stripe-go/v79/webhook"
)

// Verify checks the Stripe-Signature header before a byte of the body is trusted.
func Verify(r *http.Request, body []byte) error {
\t_, err := webhook.ConstructEvent(body, r.Header.Get("Stripe-Signature"), os.Getenv("STRIPE_WEBHOOK_SECRET"))
\treturn err
}
`,
    "migrations/0001_webhook_events.sql": `CREATE TABLE webhook_events (
    id           text PRIMARY KEY,
    kind         text        NOT NULL,
    body         jsonb       NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    leased_until timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX webhook_events_pending ON webhook_events (received_at) WHERE processed_at IS NULL;
`,
    Dockerfile: `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/worker ./cmd/worker

FROM alpine:3.20
COPY --from=build /out/worker /usr/local/bin/worker
ENTRYPOINT ["worker"]
`,
    ".gitignore": `/worker
*.test
.env
`,
};

/** Write the repo to `dir` (replacing whatever is there) and return its path plus the file count the drop carries. */
export const writeDroppedRepo = (dir) => {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, content] of Object.entries(FILES)) {
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    return { dir, files: Object.keys(FILES).length };
};
