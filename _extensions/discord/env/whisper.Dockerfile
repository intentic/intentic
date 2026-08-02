# discord voice: whisper.cpp CLI for local transcription. Only cmake is purged after: g++ and make are baked
# into the sandbox image on purpose (node-pty ships no linux prebuild, so any in-sandbox `pnpm install` compiles
# it from source), and purging them here left enabling discord voice silently breaking native installs in /work.
# git stays for the same reason. libgomp1 is whisper's OpenMP runtime, installed explicitly so it survives.
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgomp1 \
    && git clone --depth 1 --branch v1.9.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    && cmake --build /tmp/whisper.cpp/build -j --target whisper-cli \
    && install /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && rm -rf /tmp/whisper.cpp \
    && apt-get purge -y cmake && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
