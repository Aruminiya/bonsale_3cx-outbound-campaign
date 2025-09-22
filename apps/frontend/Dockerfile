# Build stage
FROM node:18 AS build

# Set the working directory
WORKDIR /app

# Copy monorepo root files first
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Copy shared packages
COPY packages ./packages

# Copy only frontend app
COPY apps/frontend ./apps/frontend

# Install all dependencies
RUN pnpm install

# Build shared types first
WORKDIR /app/packages/shared-types
RUN pnpm run build

# Build frontend with only Vite (skip tsc -b)
WORKDIR /app/apps/frontend
RUN pnpm exec vite build

# Production stage
FROM nginx:alpine AS production

# Copy built files from build stage
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html

# Copy nginx configuration
COPY apps/frontend/nginx.conf /etc/nginx/nginx.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]