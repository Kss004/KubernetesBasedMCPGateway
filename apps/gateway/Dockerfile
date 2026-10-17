FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/mcp-mini/ apps/mcp-mini/
COPY apps/gateway/ apps/gateway/
COPY apps/dashboard/ apps/dashboard/
RUN npm install --no-audit --no-fund
RUN npm run build --workspace apps/mcp-mini && npm run build --workspace apps/gateway && npm run build --workspace apps/dashboard

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/apps/dashboard/dist ./public
COPY --from=build /app/apps/mcp-mini/dist /mcp-mini/dist
COPY --from=build /app/apps/gateway/package.json ./package.json
COPY --from=build /app/apps/mcp-mini/package.json /mcp-mini/package.json
RUN npm install --omit=dev --no-audit --no-fund
RUN cd /mcp-mini && npm install --omit=dev --no-audit --no-fund
USER 1000
EXPOSE 3000
CMD ["node", "dist/index.js"]
