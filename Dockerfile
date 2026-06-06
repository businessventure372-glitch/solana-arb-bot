FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY src/ ./src/
COPY .env.example ./.env.example
CMD ["bun", "run", "src/index.ts"]
