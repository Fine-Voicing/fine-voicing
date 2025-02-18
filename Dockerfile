# Build stage
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY tsconfig.json ./
COPY package*.json package-lock.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy source code and configuration files
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Runtime stagedone
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built JavaScript files from builder stage
COPY --from=builder /app/build ./build

RUN chown node:node ./
USER node

# Expose the port your application runs on (adjust if needed)
EXPOSE $PORT

# Start the application
CMD ["node", "build/api.js"] 