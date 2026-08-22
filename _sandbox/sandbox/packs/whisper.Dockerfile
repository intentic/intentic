# whisper.cpp CLI for local speech-to-text — what the composer's voice input transcribes with
# (src/speech/transcribe.ts). In the `standard` profile so voice works out of the box; the model is NOT here
# (~1.6GB) — it downloads into the workspace volume on first use. Discord's voice transcription needs the same
# binary and NAMES THIS PACK for it (`"pack": "whisper"` in its manifest) rather than carrying a copy: on an
# image that bakes this pack it composes nothing at all, and there is no second pin to keep in step. It was a
# byte-identical fragment until then, which had a standard image compile whisper.cpp once at publish and again
# in every overlay rebuild, for the same binary.
# Only cmake is purged after: g++ and make are baked into the sandbox image on purpose (node-pty ships no
# linux prebuild, so any in-sandbox `pnpm install` compiles it from source), and purging them here left this
# pack silently breaking native installs in /work. git stays for the same reason. libgomp1 is whisper's
# OpenMP runtime, installed explicitly so it survives.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/ccache \
    apt-get update && apt-get install -y --no-install-recommends cmake ccache g++ make libgomp1 \
    && git clone --depth 1 --branch v1.9.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    && cmake --build /tmp/whisper.cpp/build -j --target whisper-cli \
    && ccache --show-stats \
    && install /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && rm -rf /tmp/whisper.cpp \
    && apt-get purge -y cmake ccache && apt-get autoremove -y
