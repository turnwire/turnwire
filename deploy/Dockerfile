FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-bookworm-slim AS relay
WORKDIR /app
COPY --from=build /app /app
RUN npm prune --omit=dev
ENV TURNWIRE_RELAY_HOST=0.0.0.0
ENV PORT=9899
USER node
EXPOSE 9899
CMD ["node", "apps/relay/dist/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/apps/remote-web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
