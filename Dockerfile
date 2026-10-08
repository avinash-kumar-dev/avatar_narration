FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
# Playwright's own installer pulls Chromium plus the system libraries it needs.
# mesa-vulkan-drivers/libgl1-mesa-dri (lavapipe/llvmpipe) are Mesa's software
# Vulkan/GL implementations — needed for RENDER_MODE=stepped on a host with no
# GPU (see README, "Running on a CPU-only host").
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      mesa-vulkan-drivers libgl1-mesa-dri libegl1 libgles2 libvulkan1 \
 && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY types ./types

ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
