# Agent container — where Claude/Codex runs.
#
# Training note on hardening:
#   Stock tier  : FROM node:24-bookworm-slim
#   Pinned tier : FROM node:24-bookworm-slim@sha256:<digest>
#   Hardened    : FROM cgr.dev/chainguard/node:latest@sha256:<digest>
#                 (requires `docker login cgr.dev`; no shell, no apt — you'd
#                 also drop the apt-get block and lose interactive bash, which
#                 is fine for non-interactive recipe runners but not for a
#                 Claude REPL.)
#
# For training we use the slim tier with pinned tooling so the shell still
# works and the demo is reproducible.

FROM ghcr.io/astral-sh/uv:0.11.7 AS uv

FROM node:24-bookworm-slim

COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    iproute2 \
    less \
    procps \
    python3 \
    python3-dotenv \
    ripgrep \
    zsh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex @anthropic-ai/claude-code

# Enable corepack so `pnpm` and `yarn` shims exist on PATH. The actual binary
# is downloaded on first use, driven by the `packageManager:` field in the
# target repo's package.json (e.g. pnpm@10.23.0). The download lands in
# /home/agent/.cache/corepack which lives on the named home volume, so it
# only happens once across sandbox launches.
RUN corepack enable

RUN groupadd --system agent \
  && useradd --system --create-home --gid agent --shell /bin/bash agent \
  && mkdir -p /workspace /sandbox-tools /home/agent/.codex /home/agent/.claude \
  && chown -R agent:agent /workspace /sandbox-tools /home/agent

WORKDIR /workspace

ENV HOME=/home/agent
ENV PATH=/sandbox-tools:/workspace/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV UV_CACHE_DIR=/home/agent/.cache/uv
ENV UV_LINK_MODE=copy
ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Skip the "download package manager?" interactive prompt — sandbox is
# non-interactive at install time.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

USER agent

CMD ["bash"]
