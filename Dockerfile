# Base image
FROM node:20-alpine

# Install PM2 + static server
RUN npm install -g pm2 serve

# Set working directory
WORKDIR /app

# Copy app files
COPY watcher.js /app/watcher.js
COPY static /app/static

# Create config mount
VOLUME ["/app/config"]

# Environment
ENV PORT=3000

# Expose HTTP port
EXPOSE 3000

# Start watcher with PM2 (daemonized), then serve static content
CMD ["sh", "-c", "pm2 start /app/watcher.js --name watcher && serve -s /app/static -l $PORT"]
