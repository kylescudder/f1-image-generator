FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run setup && npm run build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data HOME=/tmp
ARG PADDOCK_REVISION=development
ENV PADDOCK_REVISION=$PADDOCK_REVISION
LABEL org.opencontainers.image.source="https://github.com/kylescudder/f1-image-generator"
LABEL org.opencontainers.image.revision=$PADDOCK_REVISION
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts/setup.ts ./scripts/setup.ts
COPY --from=build /app/assets ./assets
# Cache official fonts in the image for offline startup; never serve font binaries publicly.
COPY --from=build /app/data/fonts /app/runtime-fonts
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN mkdir -p /app/data && chown -R 501:20 /app/data && chmod 755 /app/entrypoint.sh
USER 501:20
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/entrypoint.sh"]
