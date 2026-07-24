# Live demo sandbox — Arclear dashboard against an in-container anvil chain.
# Fully self-contained: spawns its own anvil, deploys the dual-hub + PvPRouter
# world from embedded bytecode, funds 5 agents. No keys, no external RPC.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Foundry (provides `anvil`, spawned by demo/setup.ts in --anvil mode)
RUN curl -L https://foundry.paradigm.xyz | bash \
  && /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

WORKDIR /app

# Install deps (devDeps included — tsx runs the server; do NOT set NODE_ENV=production)
COPY package.json package-lock.json ./
RUN npm ci

# App sources needed at runtime for anvil mode (contracts/, test/, .planning/ excluded via .dockerignore)
COPY tsconfig.json ./
COPY src ./src
COPY demo ./demo
COPY public ./public

ENV PORT=8080
EXPOSE 8080

# Anvil mode: self-contained, request-driven, no secrets.
CMD ["npx", "tsx", "demo/server.ts", "--anvil"]
