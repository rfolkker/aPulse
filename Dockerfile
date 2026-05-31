# Base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy app files
COPY watcher.js /app/watcher.js
COPY package-lock.json /app/package-lock.json
COPY package.json /app/package.json
COPY pm2.json /app/pm2.json
COPY static /app/static

# Install packages
RUN npm install -g pm2 serve && npm install --production

# Create config mount
VOLUME ["/app/config"]

# Environment
ENV PORT=3000

# Expose HTTP port
EXPOSE 3000

# Start watcher with PM2 (daemonized), then serve static content
CMD ["sh", "-c", "pm2 start /app/watcher.js --name watcher && serve -s /app/static -l $PORT"]
