# Build context is a temporary directory containing only this test kit and fixture.
FROM docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5 AS docker-cli
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/acceptance
COPY package.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install --ignore-scripts --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright /opt/acceptance
COPY run.mjs relay.mjs mock-model.mjs ./
ENTRYPOINT ["node", "/opt/acceptance/run.mjs"]
