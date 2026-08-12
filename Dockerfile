# Northstar has no dependencies, so there is nothing to install and no build
# step. The image is the runtime plus the source.

FROM node:22-alpine

WORKDIR /app

# Source only — data lives on a mounted volume, never in the image.
COPY package.json server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY seeds/ ./seeds/
COPY scripts/ ./scripts/

# A container's loopback is its own; the host has to be able to reach in.
ENV HOST=0.0.0.0
ENV PORT=8080

# Where the index, accounts and history are kept. This is the whole point of
# running here rather than on a serverless host: the path below is a real disk
# that survives restarts, so the index someone spent hours crawling is still
# there tomorrow.
ENV DATA_DIR=/data/

# Postings on disk, read per query — the index can outgrow memory.
ENV STORAGE=sqlite

# An index that comes up empty seeds itself from the bundled corpus, so a fresh
# deployment answers its first question rather than shrugging at it.
ENV SEED_WHEN_EMPTY=1

# Behind a load balancer, so the forwarded client address is the real one and
# rate limiting counts people rather than the proxy.
ENV TRUST_PROXY=1

EXPOSE 8080

# No package manager at runtime: one process, started directly, so signals
# reach it and the store flushes on shutdown.
CMD ["node", "server.js"]
