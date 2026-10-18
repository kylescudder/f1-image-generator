ARG BUN_IMAGE=oven/bun@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --network-concurrency 8
COPY . .
RUN bun run setup && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data HOME=/tmp
ARG PADDOCK_REVISION=development
ENV PADDOCK_REVISION=$PADDOCK_REVISION
LABEL org.opencontainers.image.source="https://github.com/kylescudder/paddock"
LABEL org.opencontainers.image.revision=$PADDOCK_REVISION
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --network-concurrency 8
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/assets ./assets
COPY --from=build /app/deploy/verify.ts ./deploy/verify.ts
# Cache official fonts in the image for offline startup; never serve font binaries publicly.
COPY --from=build /app/data/fonts /app/runtime-fonts
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN mkdir -p /app/data && chown -R 501:20 /app/data && chmod 755 /app/entrypoint.sh
USER 501:20
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["/app/entrypoint.sh"]
