# The CUDA build of llama-server, composed into the overlay by the local-model capability's GPU option and
# NEVER baked into a published profile: the CUDA runtime libraries it keeps are hundreds of MB that only a
# sandbox with the `--gpus=all` directive can use. It REPLACES the CPU binary the llamacpp pack installed at
# the same path, which is the whole upgrade: the handler's command line doesn't change, the rebuilt binary
# simply offloads when the handler passes -ngl (it does exactly when SANDBOX_GPU says the flag rode).
# The toolkit comes from NVIDIA's own apt repo (the docker GPU fragment's keyring dance, kept in step with it),
# nvcc and the dev headers are purged after the build, and the cuBLAS/cudart runtime halves stay: unlike the
# host's driver libraries (which --gpus injects at run time), the CUDA runtime is the binary's own dependency.
# Arch spread rather than `native` — there is no GPU at build time; Turing through Hopper covers the cards the
# directive's nvidia-runtime host probe admits.
# THE `rm -f` BEFORE THE INSTALL IS LOAD-BEARING. The CPU pack no longer puts a file at
# /usr/local/bin/llama-server; it puts a SYMLINK there, into /opt/llamacpp where the prebuilt release keeps its
# binary and shared libraries together (that binary's RUNPATH is `$ORIGIN`). `install` opens its destination for
# writing, which FOLLOWS a symlink — so without the unlink this would quietly write the CUDA binary into
# /opt/llamacpp/llama-server and leave /usr/local/bin pointing at it. That happens to run, which is exactly what
# makes it worth a line of comment: it would look correct while the CPU pack's install path held a CUDA binary.
#
# ponytail: this pack still BUILDS llama.cpp while llamacpp.Dockerfile downloads it — upstream publishes no
# prebuilt CUDA server for Linux (only Windows CUDA, and Vulkan/SYCL for Linux). Bump both pins together
# regardless; they are one upstream tag.
#
# THE MOST EXPENSIVE FRAGMENT IN THE PROJECT, and the reason the build-cache mounts exist: ~600MB of CUDA
# toolkit and ~900 translation units across five architectures. Nothing about it depends on the sandbox's own
# source, yet it sits above it in the overlay, so it re-ran in full on every rebuild — 19 minutes of a
# 40-minute one. The apt mounts keep the toolkit bytes and the ccache mount keeps the object files, so a
# re-run after an image update recompiles almost nothing. ccache understands nvcc, hence the CUDA launcher.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/ccache \
    install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/3bf863cc.pub -o /etc/apt/keyrings/nvidia-cuda.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/nvidia-cuda.asc] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/ /" \
        > /etc/apt/sources.list.d/nvidia-cuda.list \
    && apt-get update && apt-get install -y --no-install-recommends cmake ccache g++ make libgomp1 cuda-nvcc-12-6 cuda-cudart-dev-12-6 libcublas-dev-12-6 \
    && git clone --depth 1 --branch b10581 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp \
    && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
        -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_CUDA_COMPILER_LAUNCHER=ccache \
        -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;90" -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc \
    && cmake --build /tmp/llama.cpp/build -j --target llama-server \
    && ccache --show-stats \
    && rm -f /usr/local/bin/llama-server \
    && install /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
    && rm -rf /tmp/llama.cpp \
    && apt-get purge -y cmake ccache cuda-nvcc-12-6 cuda-cudart-dev-12-6 libcublas-dev-12-6 \
    && apt-get install -y --no-install-recommends cuda-cudart-12-6 libcublas-12-6 \
    && apt-get autoremove -y
