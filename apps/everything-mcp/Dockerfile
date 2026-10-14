FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/mcp-mini/ apps/mcp-mini/
COPY apps/everything-mcp/ apps/everything-mcp/
RUN npm install --no-audit --no-fund
RUN npm run build --workspace apps/mcp-mini && npm run build --workspace apps/everything-mcp

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /app/apps/everything-mcp/dist ./dist
COPY --from=build /app/apps/mcp-mini/dist /mcp-mini/dist
COPY --from=build /app/apps/everything-mcp/package.json ./package.json
COPY --from=build /app/apps/mcp-mini/package.json /mcp-mini/package.json
RUN npm install --omit=dev --no-audit --no-fund
# /mcp-mini is a separate package dir (file: dep), so it needs its own
# production deps: Node resolves upward from /mcp-mini/dist, never /srv.
RUN cd /mcp-mini && npm install --omit=dev --no-audit --no-fund
USER 1000
EXPOSE 3000
CMD ["node", "dist/index.js"]
