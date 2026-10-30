FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Create runtime directories for sessions and temp files
RUN mkdir -p .sessions .temp_files data

EXPOSE 4000

CMD ["node", "dist/index.js"]
