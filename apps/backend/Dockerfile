FROM node:18

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

# Copy only backend app (excluding .env files)
COPY apps/backend ./apps/backend

# Remove any .env files that might have been copied
RUN rm -f ./apps/backend/.env*

# Install all dependencies
RUN pnpm install

# Build shared types first
WORKDIR /app/packages/shared-types
RUN pnpm run build

# Build backend directly with TypeScript compiler
WORKDIR /app/apps/backend
RUN npx tsc

# Expose the port
EXPOSE 4020

# Command to run the application
CMD ["pnpm", "start"]