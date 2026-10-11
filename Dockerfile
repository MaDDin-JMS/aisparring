FROM node:25-slim

ENV NODE_ENV=production \
    DB_PATH=/data/aichat.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# `aisparring` admin CLI inside the container: docker compose exec aisparring aisparring --help
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/src/cli.js "$@"\n' > /usr/local/bin/aisparring \
 && chmod +x /usr/local/bin/aisparring \
 && ln -s /usr/local/bin/aisparring /usr/local/bin/aichat \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
