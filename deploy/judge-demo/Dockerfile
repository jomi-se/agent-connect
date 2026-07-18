FROM node:22-bookworm-slim AS node-build

WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/browser-nonce/package.json apps/browser-nonce/package.json
COPY apps/firebase-canvas/package.json apps/firebase-canvas/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/web-sdk/package.json packages/web-sdk/package.json
RUN npm ci

COPY packages/gateway packages/gateway
RUN npm run build --workspace @agent-connect/gateway \
  && npm prune --omit=dev

FROM python:3.12-slim-bookworm

ARG OMNIGENT_VERSION=0.5.1

COPY --from=node-build /usr/local/bin/node /usr/local/bin/node

RUN python3 -m venv /opt/omnigent \
  && /opt/omnigent/bin/pip install --no-cache-dir --pre \
    "opentelemetry-instrumentation-fastapi==0.64b0" \
    "opentelemetry-instrumentation-httpx==0.64b0" \
    "opentelemetry-instrumentation-sqlalchemy==0.64b0" \
  && /opt/omnigent/bin/pip install --no-cache-dir \
    "openai-agents==0.13.6" \
    "omnigent==${OMNIGENT_VERSION}"

WORKDIR /app
COPY --from=node-build /src/node_modules /app/node_modules
COPY --from=node-build /src/packages/gateway/dist /app/packages/gateway/dist
COPY scripts/deterministic-acp-agent.mjs scripts/judge-appliance.mjs /app/scripts/

RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --home-dir /home/agentconnect --create-home node \
  && mkdir -p /var/lib/agent-connect /run/agent-connect /workspace \
  && chown -R node:node /var/lib/agent-connect /run/agent-connect /workspace /home/agentconnect /app

ENV HOME=/home/agentconnect \
    PATH=/opt/omnigent/bin:/usr/local/bin:/usr/bin:/bin \
    AGENT_CONNECT_HOST=0.0.0.0 \
    AGENT_CONNECT_PORT=8787 \
    OMNIGENT_URL=http://127.0.0.1:6767 \
    AGENT_CONNECT_WORKSPACE=/workspace \
    AGENT_CONNECT_STATE_PATH=/var/lib/agent-connect/connector.json \
    AGENT_CONNECT_TRANSPORT_PROFILE=public-demo \
    AGENT_CONNECT_ACP_TRANSCRIPT=/tmp/agent-connect-acp-transcript.jsonl \
    AGENT_CONNECT_DETERMINISTIC_SCENARIOS=1

USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/scripts/judge-appliance.mjs"]
