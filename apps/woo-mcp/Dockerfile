FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
RUN npm install --workspace apps/woo-mcp --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/woo-mcp/ apps/woo-mcp/
RUN npm run build --workspace apps/woo-mcp

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /app/apps/woo-mcp/dist ./dist
COPY --from=build /app/apps/woo-mcp/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
USER 1000
EXPOSE 3000
CMD ["node", "dist/index.js"]
