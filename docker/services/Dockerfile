# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:24.22.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar && rm -rf /var/lib/apt/lists/*

FROM runtime AS control-plane
EXPOSE 8080
CMD ["node","apps/control-plane/dist/index.js"]

FROM docker:29-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 AS docker-cli
FROM runtime AS runner
RUN apt-get update && apt-get install -y --no-install-recommends python3 iptables && rm -rf /var/lib/apt/lists/*
COPY docker/browser/firewall-rules.py docker/browser/proxy-policy-helper.py /app/docker/browser/
LABEL chrome-fleet.network-policy-helper="true"
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
EXPOSE 8091
CMD ["node","apps/runner/dist/index.js"]
