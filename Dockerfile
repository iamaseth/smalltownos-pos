FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && npm rebuild better-sqlite3

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci


FROM node:22-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/frontend/node_modules ./frontend/node_modules
COPY . .

# Build the Electron backend modules for headless Node execution, then create
# the static frontend consumed by main/server.ts. TypeScript is checked
# separately because Next 16.3.5 cannot parse --showConfig for this app.
RUN npm run build
WORKDIR /app/frontend
RUN npx tsc --project tsconfig.build.json --noEmit --pretty false
RUN NEXT_BUILD_MODE=desktop NEXT_BUILD_TYPECHECKED=1 npm run build

WORKDIR /app
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV FLO_DEV_USER_DATA=/data

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dev-server.js ./dev-server.js
COPY --from=builder /app/frontend/out ./frontend/out

RUN mkdir -p /data

EXPOSE 3001

CMD ["node", "dev-server.js"]
