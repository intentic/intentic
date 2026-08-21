# llama.cpp's llama-server for the local-model capability — one pinned static binary serving an
# OpenAI-compatible /v1 for one GGUF file (capabilities/handlers/localmodel.ts starts it per entry; the
# weights are NOT here, they download into the workspace cache on add, the whisper-pack precedent). CPU build:
# the GPU variant is the separate llamacpp-cuda pack, overlay-only, because its CUDA runtime is hundreds of MB.
# In the `standard` profile so adding a local model on the published image never asks for a rebuild.
# Build-dep handling mirrors whisper.Dockerfile exactly (and for its reasons): only cmake is purged after —
# g++/make/git are baked into the sandbox image on purpose and must survive; libgomp1 is the OpenMP runtime,
# installed explicitly so it does too. -DLLAMA_CURL=OFF because the daemon owns every download; the server
# never fetches weights itself.
# ponytail: bump the pin deliberately; a llama.cpp server-API change surfaces as a local-model-only failure.
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgomp1 \
    && git clone --depth 1 --branch b6100 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp \
    && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF \
    && cmake --build /tmp/llama.cpp/build -j --target llama-server \
    && install /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
    && rm -rf /tmp/llama.cpp \
    && apt-get purge -y cmake && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
