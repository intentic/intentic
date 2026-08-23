# Local models without leaving the workspace: the design

How someone runs a model on their own hardware and chats with it in Intentic without installing anything
outside the workspace: a **Local model** capability card that picks a model, downloads its weights, runs an
inference server inside the sandbox, and surfaces it in the model picker like any other provider. One add,
zero terminals, optional GPU behind the one rebuild the platform already knows how to ask for. This records
the reasoning and the options that lost; §8 records what changed when it was built.

## 1. The gap

Today the only path to a local model is the `endpoint` capability
(`_platform/capability-catalog/src/index.ts`, the "Model endpoint" card): the owner installs Ollama or vLLM
on the host themselves, starts it, remembers `host.docker.internal`, and points the card at it. The card's
own guide says it plainly: "Start your model server" is step one, and it happens outside the product.

That path is right for people who already run a model server. For everyone else it fails four ways:

- **It requires leaving the workspace.** Install a runtime on the host, pull a model, keep it running.
  None of it is visible from the product, and none of it is recoverable from the product when it breaks.
- **The best-known failure is silent.** `handlers/endpoint.ts` documents it: a server that is up with no
  model loaded is "the single most common way an Ollama install disappoints its owner". The card can name
  the symptom but cannot fix it, because the server isn't ours.
- **Hosted sandboxes have no host.** A microVM flavor (`SANDBOX_VM=1`) has no owner-side machine to run
  Ollama on; for those users the endpoint card's local story is simply false.
- **The agent can't ask for it.** The capabilities gate lets an agent request a connection mid-task and the
  owner approve it on a card. But approving a card is one click, and "go install Docker and Ollama" is an
  afternoon; a setup that big cannot ride an approval.

## 2. What already exists

The design below is short because almost every part is already built and shipping. Worth listing, because
each one removes a piece of scope:

| Mechanism | Where | What it gives us |
| --- | --- | --- |
| Endpoint → translator seam | `endpoints/endpoint-translator.ts` | Any OpenAI-compatible URL becomes one CLIProxyAPI `openai-compatibility` entry; from there it is indistinguishable from every other provider, so picker, harness, and catalog probing all come free |
| Feature packs | `environment/packs.ts` | One checked-in Dockerfile fragment, baked into the standard image by a profile or composed into the overlay on demand; the two paths cannot drift |
| Privileged runtime directives | `sandbox-run/src/index.ts`, docker handler | `# intentic:runtime --gpus=all` already exists, allowlisted, owner-approved via the overlay; the runner already stamps `SANDBOX_GPU` (`all` / `unsupported`) so the failure is legible |
| Big-weights precedent | `packs/whisper.Dockerfile` | Binary baked (small), weights downloaded into the workspace volume on first use (~1.6 GB and nobody complains) |
| Long-running process supervision | docker handler's panel session | A visible `panel-*` terminal, started by `apply`, restored on boot (`startDockerdIfEnabled`), status probed live |
| Pre-rebuild add | endpoint + docker handlers | Adding a capability whose runtime isn't there yet stores the entry and lets the card report what is actually true, instead of punishing the order the user did things in |
| Quick-model ladder | `sandbox-contract/src/quick-model.ts` | `endpoint/<id>` providers are already pinnable for utility jobs (commit messages, titles); a free local model is the natural pin |

The design puts these seven things behind one card.

## 3. Options considered

**A. Extension-shipped runtime.** An extension contributes an environment fragment installing Ollama plus a
prefilled endpoint card. It loses twice. Extension fragments are RUN/ENV-only *by design*
(`environment/fragment-sources.ts`, where `invalidExtensionFragment` rejects any `intentic:runtime` line),
so an extension can never carry the GPU grant, and CPU-only is a real product for 4B models but a dead end.
And the supervision half (start the server, restore it on boot, probe it for status, report download
progress) is handler code, which extensions don't ship. Extensions remain the right vehicle for
*third-party* runtimes later; not for the first-party path.

**B. Sidecar in the nested Docker engine.** `docker run ollama/ollama` inside the docker capability, which
already has a GPU option. It works today with zero new code, and an agent can be talked through it, but as
the product answer it is strictly worse: it drags in `--privileged`, needs the GPU passed through *two*
layers (the docker GPU fragment's `nvidia-ctk` dance exists precisely because nesting is hard), and parks
weights inside the nested engine's data-root where nothing else can see them. Fine as a documented recipe;
not the card.

**C. Host-side helper.** `ic model up` installs and runs a server on the owner's machine and auto-adds the
endpoint capability pointing at `host.docker.internal`. It dedups weights across every sandbox on the host
and gets the GPU without any container passthrough, which is better economics for hosts running several
sandboxes. But it reintroduces the exact thing being removed ("leave the workspace, run our installer"),
needs per-OS install paths, and covers hosted sandboxes not at all. Worth revisiting as a *weights cache*
optimization once the in-sandbox path exists; wrong as the front door.

**D. In-sandbox managed runtime, as a core capability.** Everything runs where the agent runs, on the
mechanisms above. Chosen. The rest of this document is D.

## 4. The design: a "Local model" capability

### The user's walkthrough

1. Capabilities page → **Local model** card (category `extend`, beside "Model endpoint"). Or the agent asks
   for it mid-task through the capabilities gate and the owner approves the card in chat.
2. One decision: **which model**, a curated select that states the cost in the label ("Qwen3.5 9B, needs
   ~6 GB free RAM", "Qwen3.8 27B, needs ~24 GB"). One optional switch: **Use this machine's NVIDIA
   GPU**, wearing the `rebuild` chip the field schema already has for exactly this
   (`extension-manifest/src/points/capabilities.ts` cites the docker card's pair of identical-looking
   switches, one costing five seconds and the other five minutes).
3. Add. On the standard image with the GPU switch off, **nothing rebuilds**: the CPU inference server is
   already baked (see §runtime). The add **returns immediately** and the weights arrive behind it: the
   entry lands, and its row on the card carries the progress (`downloading 2.1 / 18.6 GB`) on the poll
   clock the connections list already runs for anything pending, so a refresh or a visit tomorrow reads the
   same live answer. An add that streamed to the end of the download instead held a spinner for the length
   of a twenty-gigabyte transfer, said nothing while it did (an apply's log frames have no surface on that
   form: the progress surface there is a tmux pane, and an in-process download has no pane), and lost the
   download with the tab, since the manifest entry is not written until apply returns.
4. GPU on: the fragment lands in the overlay, the card reads "pending, rebuild required", the owner
   approves the same Environment-card rebuild every other image change rides. After the rebuild the server
   starts with the GPU, or the card says exactly why not (`SANDBOX_GPU=unsupported` → "this host's Docker
   has no nvidia runtime, install nvidia-container-toolkit on it", the docker card's existing sentence).
5. From then on it is just a provider: picker entry, quick-model pin, subagent turns. Boot restores the
   server the way boot restores dockerd.

Nothing in that walkthrough opens a terminal, installs anything on the host, or mentions Docker.

### The runtime: llama.cpp's `llama-server`, not Ollama

Ollama is what users name, but it is a model *manager* with its own store, its own daemon and its own pull
protocol: a product embedded in ours. `llama-server` is one pinned static binary that serves an
OpenAI-compatible `/v1` for one GGUF file, which is exactly the shape packs and panels want:

- **CPU build baked into the `standard` profile** (`packs/llamacpp.Dockerfile`, built like whisper's: same
  repo, same pin discipline). The binary is small; baking it is what makes the no-rebuild add real.
- **CUDA build as an overlay-only pack** (`llamacpp-cuda.Dockerfile`) composed when the GPU switch is on,
  together with the directive. It is hundreds of MB of CUDA runtime, which is why it is not baked.
- One process serves one model. A second model is a second card entry, named the way endpoint entries are.
  That is simpler than teaching one card to multiplex, and the picker treats each as a provider row anyway.

The curated model list lives in the catalog card as select `options`, so shipping a new recommended model is
a catalog change, not a daemon release. An optional advanced field takes a raw GGUF URL for people who know
what they want.

### The handler, mapped onto existing shapes

- `fragment(config)`: `packFragment("llamacpp")` (nothing on the standard image) plus, when
  `config.gpu === "on"`, `packFragment("llamacpp-cuda")` and `# intentic:runtime --gpus=all`. The GPU story
  here is *simpler* than docker's: no nested engine, so no toolkit, no `nvidia-ctk`, no daemon.json merge.
  The outer flag is the whole grant.
- `apply`: **start** the background job (download the weights if absent, then start `llama-server` as the
  `panel-model-<id>` session) and return one line saying so. The job is per entry and idempotent, so Update
  during a download joins the one in flight; the download itself is keyed by destination path, so two cards
  naming the same weights watch one transfer. Pre-rebuild and mid-download are soft outcomes the card
  reports as such, per the endpoint/docker precedent.
- Resume: the part file is named after the model (`<weights>.part`), not after the attempt, and the next
  attempt asks for a range from wherever it stopped: HF through the hub blob's own `slice`, a custom URL
  through a `Range` header, with a 200 answer meaning "this server won't, start over". A daemon restart
  mid-download therefore costs the bytes in flight rather than the whole transfer, and boot picks it up
  beside the servers it restores.
- `status`: server answering → `active`, detail naming the model; downloading → `pending`, detail
  `2.1 / 4.6 GB`; GPU asked but `SANDBOX_GPU` missing → `pending`, `rebuild required`; `unsupported` → the
  docker card's error sentence; server dead → `error` pointing at the panel terminal. It is also where a
  background failure surfaces, since a job nobody is streaming has no error frame to throw.
- `remove`: stop the panel, drop the translator entry, *leave the weights*. A multi-GB delete should be its
  own deliberate step, and the agent can do it on request; the card's model-field hint says the download is
  kept.
- Boot: `startModelIfEnabled` beside `startDockerdIfEnabled`.

### Weights

`.intentic/local/cache/models/` on the workspace volume, keyed by file name so two entries naming the same
model download it once: survives rebuilds, never syncs, and follows the whisper precedent exactly, under
`cache/` because that is what weights ARE, re-downloadable by content, which is the promise that keeps them
out of exports and hands them to the state janitor. `remove` deliberately leaves them (a multi-GB delete is
its own act, the agent does it on request). The known cost: two sandboxes on one host each hold their own
copy. Accepted for v1; the fix, when it matters, is option C reborn as a host-side read-only cache mount the
runner offers, an optimization invisible to the card.

### Wiring into the picker

No new turn path. `translatedEndpoints` grows to include `localmodel` capabilities, each expressed as the
`EndpointConfig` it effectively is (`http://127.0.0.1:<port>/v1`, openai protocol, no key), so the
translator, the catalog prober, the picker and `endpoint/<id>` quick-model pinning all engage untouched.
The one deliberate divergence from a user-added endpoint: the daemon owns the URL, so the card never shows
one.

The one seam that could **not** be inherited untouched is *when* the routing table is written. The capability
routes sync it on add/update/rename/remove, and for a user-added endpoint that is right: the server it names is
already running, so the catalog read at add time is the truth. A local model is added minutes before it can
serve, so that sync writes `models: []` — and an `openai-compatibility` entry declaring no models is not an
endpoint waiting to fill in, it is a provider that refuses every request with `unknown provider for model`.
Nothing else in the daemon watches for the download to finish, so the entry stayed unroutable for the life of
the sandbox while its card read "active" and llama-server sat healthy on loopback. The background job therefore
polls `/health` after it spawns the server and re-syncs the moment it answers 200 (`syncWhenServing`). The
watcher is bounded (twenty minutes), ends early on a dead panel, and is cancelled by remove and rename; it is
held outside the download job's map so that pressing Update on a model stuck loading still restarts it.

### What the card's copy promises

A 4B model does not drive the frontier harness well, and the card should not imply it does. The hint sells
what is true: private, free, offline-capable; good as the quick model for commit messages and titles, for
subagent utility turns, and for work that must not leave the machine. The quick-model ladder was built
for exactly this pin: `endpoint/<id>` providers only win Auto when nothing else is connected, but a pin
holds, which is the correct default posture for a model of unknowable quality.

## 5. What stays

The **Model endpoint** card stays as-is: it is the power path for the GPU box across the network, the vLLM
someone already operates, the LiteLLM gateway. The new card's copy should point sideways at it in one line.
The nested-docker recipe (option B) is worth a docs page for people who want Ollama specifically, and
option C's host cache is the follow-up once real usage shows weight duplication hurting.

## 6. Open questions

- **Model curation.** Who maintains the select list and its RAM labels, and does the card read host RAM
  (the daemon knows it) to sort or annotate options it can't actually fit?
- **Non-NVIDIA GPUs.** A Vulkan build of `llama-server` would cover AMD/Intel without CUDA's bulk, but
  `--gpus=all` is an NVIDIA-runtime flag; other vendors need `/dev/dri` device directives the allowlist
  doesn't currently speak. Punt for v1, matching the docker card's NVIDIA-only stance.
- ~~**Context length vs RAM.**~~ Settled the hard way; see §8's last entry. The answer was one flat
  conservative cap plus a quantized cache, not per-entry defaults.
- **The hosted flavor.** CPU inference works there today; whether hosted hosts ever offer GPUs is a
  platform pricing question, not a design one. `SANDBOX_GPU` already carries the answer either way.

## 7. Build order

1. `llamacpp` pack + standard-profile bake (the whisper playbook).
2. `localmodel` capability: catalog card, handler (apply/status/panel/boot), weights download.
3. `translatedEndpoints` inclusion: picker and quick-model pinning start working.
4. GPU: `llamacpp-cuda` pack + directive + `SANDBOX_GPU` status sentences.
5. Docs: the sideways pointer on the endpoint card, the Ollama-in-docker recipe page.

Slices 1–3 are the whole CPU product and never ask for a rebuild on the standard image; they can ship alone.

## 8. What was built

All five slices landed together. The map, for whoever touches this next:

- **Contract**: the `localmodel` kind, `LocalModelConfigSchema` (`model` HF path / `"custom"` + `url`,
  `gpu` on/off) and its union arm (`_sandbox/sandbox-contract/src/schemas.ts`). Providers stay `endpoint/<id>`
  on purpose: no new namespace, no new turn path.
- **The join**: `_sandbox/sandbox/src/endpoints/local-model.ts`: the id-derived loopback port (FNV-1a into
  40100–40499), `endpointConfigOf` (THE reader of "which capabilities are endpoints"), and the model-source
  parse. Consumers: `endpoint-translator.ts`, `harness-credentials.ts`, `endpoints.routes.ts`,
  `agent/quick-model.ts`, the capability routes' sync hooks, the web picker's capability load.
- **The handler**: `_sandbox/sandbox/src/capabilities/handlers/localmodel.ts`: hub-download with staged
  rename and decile progress, `panel-model-<id>` session, `/health`-probed status, boot restore beside
  dockerd's (a live server is adopted across daemon restarts, not killed, since reloading a big model costs
  minutes).
- **Packs**: `llamacpp` (CPU, baked in `standard`), `llamacpp-cuda` (overlay-only). The stamps test now
  pins that an off-profile pack is NOT stamped, the first pack of that shape.
- **Card + effects**: `_platform/capability-catalog`: curated select with RAM-honest labels, `when`-gated
  custom URL, GPU switch wearing the rebuild chip; effects are the process row plus image+gpu exactly when
  the switch is on.
- **Directive dedupe**: `runtimeDirectivesOf` (sandbox-run) now dedupes tokens, since the docker card's GPU
  option and a local model's both emit `--gpus=all`, and one flag must reach `docker run`.
- **Docs**: models + docker + capabilities pages; the endpoint card and this card point at each other.
- **The conversation cache is capped and quantized**, and this closes §6's context-vs-RAM question by having
  got it wrong first. The build shipped "read the context length from the model", which reads like generosity
  and is the setting that made every RAM label on the card unachievable: a modern instruct model advertises
  128K–256K native, and the KV cache for a window that wide is larger than the weights it serves. Measured off
  the GGUF metadata of models on the curated list: a 3B at its native 131072 wants **14.0 GB** of f16 KV on
  top of 1.9 GB of weights, against a card reading "~4 GB"; a 30B at 262144 wants **24.0 GB** on top of
  17.3 GB, against a card reading "~24 GB". The two outcomes were "the allocation fails and the model never
  serves" and "it serves after eating the machine", and which one a user got depended on hardware the card
  never asked about. Now: a flat 32768-token cap (the smallest window that still holds a real agent turn with
  the harness's tool set) and `q8_0` for both halves of the cache, which together put the reservation back in
  the 1.5–2 GB band the labels already carry. Flash attention is left at its `auto` default rather than forced,
  because upstream enables it itself when the V cache is quantized and errors only when it was explicitly
  disabled. Flat rather than per-entry because the per-token cost varies only ~2x across this list, which one
  conservative cap absorbs, where a per-row number is arithmetic somebody has to redo by hand on every model
  added. The cap and the labels are pinned to each other by an integration test and by comments in both
  directions, since the drift is invisible from either side alone: one is a string in the catalog, the other a
  flag in the handler. Known narrowing: `q8_0` blocks are 32 wide and upstream refuses a quantized cache whose
  head dimension does not divide by that, unreachable for the curated list (all 128) and a loud startup failure
  in the entry's panel for a custom GGUF that hits it.

## 9. Runtimes evaluated since

**NInfer** (Aug 2026), which is what enthusiast threads recommend over llama.cpp for single-GPU decode, and
which does win it: roughly 2–3x on generation for Qwen3.8-27B via MTP speculative decoding, trailing llama.cpp
by 15–24% on prefill. It cannot be this card's runtime, and not for a close reason. It builds for `sm_120a`
only, i.e. one consumer GPU (forks exist per architecture, which is itself the tell); it has **no CPU path**,
which is the entire no-rebuild product; it ships **no binary or install target**, so it would be a CUDA-13
source build in the image against a prebuilt release chosen deliberately for portability (see the pack's
SIGILL note); it accepts **five registered Qwen checkpoints** in its own `.ninfer` container, not GGUF, so the
curated list and the custom-URL field both die with it; and it needs FFmpeg development libraries. It is a
tuned artifact for one card, not a runtime a product can stand on. If the GPU path ever justifies a
second engine, the shape to reach for is the *endpoint* card pointed at whatever the owner built themselves,
which already works and costs us nothing.

The transferable half of that community advice was not the engine. It was the serving configuration — Unsloth's
quants (already on the curated list) with a quantized KV cache — and that is the §8 entry above.
