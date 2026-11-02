# ---- build the web UI ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.BASE_PATH||'')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
