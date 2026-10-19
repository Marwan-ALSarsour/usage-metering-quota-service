FROM node:22-alpine

WORKDIR /app

# Install dependencies with exact lockfile versions
COPY package.json package-lock.json ./
RUN npm ci

# Copy configuration, migrations, and source files
COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/

# Compile TypeScript and copy frontend static assets to dist/src/public
RUN npm run build

# Expose service port (API & Demo UI)
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

HEALTHCHECK --interval=5s --timeout=3s --retries=5 --start-period=5s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Starts API: runs database migrations, seeds predefined plans, then starts HTTP server
CMD ["npm", "start"]
