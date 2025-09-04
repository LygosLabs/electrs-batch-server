# Use Node.js 20 LTS Alpine for security and smaller size
FROM node:20-alpine

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S electrs -u 1001

# Set working directory
WORKDIR /usr/src/electrs-batch-server

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies with clean npm cache
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Change ownership to non-root user
RUN chown -R electrs:nodejs /usr/src/electrs-batch-server

# Switch to non-root user
USER electrs

# Expose port (configurable via PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Use exec form for proper signal handling
CMD ["node", "-r", "dotenv/config", "index.js"]
