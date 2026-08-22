# llama.cpp's llama-server for the local-model capability — one pinned static binary serving an
# OpenAI-compatible /v1 for one GGUF file (capabilities/handlers/localmodel.ts starts it per entry; the
# weights are NOT here, they download into the workspace cache on add, the whisper-pack precedent). CPU build:
# the GPU variant is the separate llamacpp-cuda pack, overlay-only, because its CUDA runtime is hundreds of MB.
# In the `standard` profile so adding a local model on the published image never asks for a rebuild.
# Build-dep handling mirrors whisper.Dockerfile exactly (and for its reasons): only cmake is purged after —
# g++/make/git are baked into the sandbox image on purpose and must survive; libgomp1 is the OpenMP runtime,
# installed explicitly so it does too. The web UI is off (both flags): this server answers a loopback API and
# nothing renders its pages, and leaving it on has the build reach Hugging Face for prebuilt assets or run npm.
#
# WHY THE PIN IS WHERE IT IS, and the class of bug that moves it. llama-server converts every tool's JSON
# schema into a grammar before it will serve a request, and it used to REFUSE a property that names no type
# ({"description": "…"}, which JSON Schema reads as "any value"): "Unrecognized schema", HTTP 500, whole turn
# dead. The harness sends one of those in its own tool set, so nothing the user could pick or configure avoided
# it — every tool-carrying turn against a local model failed on the first request, while the retry watchdog made
# it look like a turn that was merely thinking. Upstream now treats a typeless schema as the free-form value it
# is, which is the floor this pack has to clear: a local model is only useful to an agent that can call tools.
# ponytail: bump the pin deliberately; a llama.cpp server-API change surfaces as a local-model-only failure.
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgomp1 \
    && git clone --depth 1 --branch b10581 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp \
    && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
    && cmake --build /tmp/llama.cpp/build -j --target llama-server \
    && install /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
    && rm -rf /tmp/llama.cpp \
    && apt-get purge -y cmake && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
