FROM oven/bun:1.1-alpine AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun build src/index.ts --target=bun --outfile=dist/indexer.js

FROM oven/bun:1.1-alpine

WORKDIR /app

COPY --from=builder /app/dist/indexer.js ./indexer.js
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/data

ENV PORT=3001
ENV DATABASE_PATH=/app/data/indexer.db
VOLUME /app/data

EXPOSE 3001

CMD ["bun", "run", "indexer.js"]
