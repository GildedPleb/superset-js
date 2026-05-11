FROM oven/bun:1 AS base
WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Production stage (optimized for long-running concurrent pipeline)
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

# The app runs continuously (pipelines + retention + discovery etc.)
CMD ["bun", "src/main.ts"]