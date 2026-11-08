FROM node:22-bookworm-slim AS dependencies

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci


FROM node:22-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY --from=dependencies /app/frontend/node_modules ./frontend/node_modules
COPY frontend ./frontend
COPY shared ./shared
COPY main/countries.ts ./main/countries.ts
RUN ln -s /app/frontend/node_modules /app/node_modules

WORKDIR /app/frontend
RUN npx tsc --noEmit --pretty false
RUN NEXT_BUILD_TYPECHECKED=1 npm run build
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY --from=builder /app/frontend/package.json /app/frontend/package-lock.json ./frontend/
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/next.config.ts ./frontend/next.config.ts
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/main/countries.ts ./main/countries.ts
RUN ln -s /app/frontend/node_modules /app/node_modules

WORKDIR /app/frontend

EXPOSE 3000

CMD ["sh", "-c", "npm run start -- --hostname 0.0.0.0 --port ${PORT:-3000}"]
