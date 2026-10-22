FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/outbox.sqlite PACK_ROOT=/app
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY review ./review
# The private forbidden-claims list is not in the public repo. The build pipeline stages
# content/<brand>/rules.json into the build context before docker build. Without it,
# the service starts with ok:false health and rejects every submit.
COPY content ./content
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
STOPSIGNAL SIGTERM
# Deployment stop grace must be at least 100 seconds for the 90-second publish budget;
# otherwise SIGKILL can interrupt a post that will be marked uncertain on the next boot.
# /healthz always returns 200; require the queue to run. A bad X probe or missing rules cannot be fixed by restarting and must not cause a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>r.status===200?r.json():Promise.reject()).then(j=>process.exit(j.queueRunning===true?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
