FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/provisioner/ apps/provisioner/
RUN npm install --no-audit --no-fund
RUN npm run build --workspace apps/provisioner

# helm, pinned and checksum-verified (official release; same binary as the VPS, docs/versions.md).
FROM node:24-alpine AS helm
ARG HELM_VERSION=v4.3.0
ARG HELM_SHA256=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb
RUN wget -q -O /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
 && echo "${HELM_SHA256}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp linux-amd64/helm

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production HOME=/tmp HELM_CACHE_HOME=/tmp/helm/cache HELM_CONFIG_HOME=/tmp/helm/config HELM_DATA_HOME=/tmp/helm/data
COPY --from=helm /tmp/linux-amd64/helm /usr/local/bin/helm
COPY --from=build /app/apps/provisioner/dist ./dist
COPY --from=build /app/apps/provisioner/package.json ./package.json
# The store chart this provisioner installs, one copy per store namespace.
COPY charts/store /charts/store
RUN npm install --omit=dev --no-audit --no-fund
USER 1000
CMD ["node", "dist/index.js"]
