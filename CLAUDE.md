# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Bonsale 3CX Outbound Campaign System** - A monorepo application that integrates 3CX phone system with Bonsale CRM to enable automated large-scale outbound calling campaigns with real-time monitoring.

- **Monorepo Structure**: Backend (Express.js + TypeScript), Frontend (React + Vite), Shared Types
- **Real-time Communication**: WebSocket integration with 3CX and frontend dashboard
- **Package Manager**: pnpm 8.6.0
- **Build Orchestration**: Turbo
- **Containerization**: Docker Compose (development & production)
- **Deployment**: GCP Container Registry + Compute Engine VM
- **Language**: TypeScript 5.x, Node.js 18+

## Essential Commands

### Development Environment

```bash
# Install dependencies (from root)
pnpm install

# Start all services in development mode
pnpm run dev

# Run specific services
pnpm run backend    # Backend only (port 4020)
pnpm run frontend   # Frontend only (port 4030)

# Docker-based development
pnpm run docker:up    # Start with Docker Compose
pnpm run docker:down  # Stop Docker containers
```

### Building & Type Checking

```bash
# Build all packages
pnpm run build

# Type checking without build
pnpm run type-check

# Clean all build artifacts
pnpm run clean
```

### Code Quality

```bash
# Lint all packages
pnpm run lint

# Auto-fix linting issues
pnpm run lint:fix

# Run all tests
pnpm run test
```

### Docker Compose Management (Production)

```bash
# Production deployment
docker-compose -f docker-compose.prod.yml up -d
docker-compose -f docker-compose.prod.yml ps
docker-compose -f docker-compose.prod.yml logs -f backend

# Restart specific service
docker-compose -f docker-compose.prod.yml restart backend

# Stop all services
docker-compose -f docker-compose.prod.yml down
```

### Development URLs

- Frontend Dashboard: `http://localhost:4030`
- Backend API: `http://localhost:4020`
- Redis Commander: `http://localhost:8081`

## Architecture Overview

### High-Level Flow

```
Client Browser (React)
    ↓ WebSocket (Real-time updates)
Express API Server (Node.js)
    ├→ 3CX System (WebSocket for call control)
    ├→ Bonsale CRM (REST API for customer data & callbacks)
    └→ Redis (State persistence & recovery)
```

### Key Components

#### Backend (apps/backend/src)

**Core Classes:**
- `project.ts` (2316 lines) - Main campaign orchestration logic, call state management
- `projectManager.ts` - Redis persistence for project state
- `callListManager.ts` - Call queue management from Redis
- `tokenManager.ts` - OAuth2 token refresh for 3CX
- `webSocketManager.ts` - WebSocket connection handling

**Services:**
- `bonsale.ts` - Bonsale CRM API integration
- `callControl.ts` - 3CX call control operations
- `redis.ts` - Redis client initialization

**WebSockets:**
- Main server for frontend dashboard connections
- 3CX integration WebSocket for call events
- Bonsale webhook WebSocket for project updates

**Entry Point:** `src/app.ts` - Express setup and server initialization

#### Frontend (apps/frontend/src)

**Main Components:**
- `Home.tsx` (880 lines) - Main dashboard with real-time project statistics
- `Navbar.tsx` - Navigation and controls
- `ProjectCustomersDialog.tsx` - Customer list display modal
- `CustomerDetailsTable.tsx` - Detailed customer information

**Custom Hooks:**
- `useConnectBonsaleWebHookWebSocket.ts` - WebSocket connection management
- `useProjectOutboundData.ts` - Project data synchronization
- `api/*` - Bonsale API integration hooks

**Technology:**
- Material-UI (MUI) for components
- Styled Components for styling
- React Router for navigation
- Vite for fast builds

#### Shared Types (packages/shared-types/src)

Centralized TypeScript type definitions:
- `ApiResponse<T>` - API response wrapper format
- WebSocket message types (`ClientToServerMessage`, `ServerToClientMessage`)
- Project data structures
- Authentication types
- Pagination interfaces

### Data Flow

1. **Campaign Start**: Frontend sends start command → Backend creates Project instance → Fetches customer list from Bonsale → Initiates outbound calls via 3CX
2. **Call State Updates**: 3CX sends events via WebSocket → Backend updates project state → Redis persists state → Frontend receives updates via WebSocket
3. **Results Recording**: Call completion → Backend sends results to Bonsale → Updates local Redis state
4. **Recovery**: Server restart → ProjectManager loads active projects from Redis → Resumes campaign execution

### Redis Schema

Projects stored with key pattern: `project:${projectId}`
- Contains all project state (campaign config, call status, timing restrictions)
- Used for recovery on restart
- Enables multi-instance deployment

Call lists stored with pattern: `outbound:${projectId}`
- Queue of customers to call
- Updated as campaigns progress

## Environment Variables

### Required (3CX Integration)
```
HTTP_HOST_3CX=<3CX_SERVER_URL>
WS_HOST_3CX=<3CX_WEBSOCKET_URL>
ADMIN_3CX_CLIENT_ID=<CLIENT_ID>
ADMIN_3CX_CLIENT_SECRET=<CLIENT_SECRET>
ADMIN_3CX_GRANT_TYPE=client_credentials
```

### Required (Bonsale CRM)
```
BONSALE_HOST=<BONSALE_API_ENDPOINT>
BONSALE_X_API_KEY=<YOUR_API_KEY>
BONSALE_X_API_SECRET=<YOUR_API_SECRET>
```

### Required (Core Service)
```
HTTP_PORT=4020
NODE_ENV=production
REDIS_URL=redis://redis:6379
```

### Optional (Advanced Features)
```
AUTO_RECOVER_ON_RESTART=true          # Auto-restart projects on server restart
IS_STARTIDLECHECK=false               # Enable idle detection and recovery
IDLE_CHECK_INTERVAL=30000             # Check interval in milliseconds
IDLE_CHECK_BACKOFF_FACTOR=1.5         # Exponential backoff multiplier
HTTP_HOST_MESSAGE_FOR_AI=<URL>        # AI message service integration
DEFAULT_SUPPORTED_CALL_TYPES=Wextension
```

See `.env.example` for full configuration template.

## Docker Architecture

### Development (docker-compose.yml)
- Builds images locally from Dockerfile
- All services in one network: `bonsale-network`
- Backend depends on Redis
- Frontend depends on Backend
- Source code mounted for development changes

### Production (docker-compose.prod.yml)
- Uses pre-built images from GCP Container Registry
- Enhanced logging with log rotation
- Same orchestration pattern as dev
- Images pulled from: `gcr.io/drvet-server-sysstore-bonvies/`

### Building & Pushing Images

```bash
# Build backend
docker build --platform linux/amd64 \
  -f apps/backend/Dockerfile \
  -t gcr.io/<YOUR_PROJECT>/bonsale_3cx-outbound-campaign_backend:latest .

# Build frontend
docker build --platform linux/amd64 \
  -f apps/frontend/Dockerfile \
  -t gcr.io/<YOUR_PROJECT>/bonsale_3cx-outbound-campaign_frontend:latest .

# Push to GCP
docker push gcr.io/<YOUR_PROJECT>/bonsale_3cx-outbound-campaign_backend:latest
docker push gcr.io/<YOUR_PROJECT>/bonsale_3cx-outbound-campaign_frontend:latest
```

## Key Technical Decisions

### Cross-Day Call Restrictions
- `callRestriction` in projects supports time ranges that span midnight (e.g., 14:00-01:30)
- Logic checks if `startTime < stopTime` for same-day, otherwise uses OR condition for cross-day
- All times use UTC+0 format for consistency

### Monorepo Workspace Structure
- Uses `pnpm-workspace.yaml` for workspace definition
- Turbo for build orchestration and caching
- Shared types package ensures type safety across all apps
- Each app has independent package.json and build configuration

### State Persistence
- Redis is central to project state management
- Project state includes campaign config, call history, timing restrictions
- Automatic recovery mechanism allows projects to resume after server restart
- Mutex locking prevents race conditions during concurrent calls

### WebSocket Communication
- Native `ws` library for 3CX integration (connection pooling)
- Separate WebSocket server for frontend dashboard (real-time updates)
- Bonsale integration uses both REST API and WebSocket hooks
- All communication includes timestamp logging for debugging

## Common Development Scenarios

### Adding a New API Endpoint

1. Define types in `packages/shared-types/src/`
2. Create service function in `apps/backend/src/services/` or `routes/`
3. Add route handler in `apps/backend/src/routes/bonsale.ts`
4. Update frontend hook in `apps/frontend/src/hooks/api/`
5. Use hook in React component with proper error handling
6. Run `pnpm run type-check` to verify types across monorepo

### Debugging Project Logic

Key debugging points in `apps/backend/src/class/project.ts`:
- `executeOutboundCalls()` - Main campaign execution loop (line ~900)
- `processCallerOutbound()` - Per-extension call handling (line ~1094)
- `callRestriction` validation - Time-based restrictions (line ~920)
- Redis state updates - Persistent state management

Use `logWithTimestamp()` for development logging - timestamps are centralized in `src/util/timestamp.ts`

### Adding Features to Dashboard

1. Update types in shared-types if needed
2. Add backend WebSocket message in `ClientToServerEvents`/`ServerToClientEvents`
3. Create custom hook in `apps/frontend/src/hooks/`
4. Add UI component using MUI in `apps/frontend/src/components/` or `pages/`
5. Connect hook to component and handle state updates
6. Test with Docker: `pnpm run docker:up`

### Testing Configuration Changes

```bash
# Local test with Docker
pnpm run docker:up

# Access services
curl http://localhost:4020/api/bonsale/...
open http://localhost:4030

# View logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Clean up
pnpm run docker:down
```

## Code Quality Standards

### Pre-commit Hooks (via Husky)
- Backend: `eslint src/**/*.ts`, `type-check`
- Frontend: `eslint .`
- Runs on staged files only via lint-staged

### TypeScript Configuration
- `strict: true` enforced across all packages
- Path aliases configured:
  - Backend: `@/`, `@shared/`
  - Frontend: Standard tsconfig

### Naming Conventions
- Classes: PascalCase (ProjectManager, CallListManager)
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE
- Private methods: prefixed with `_` or marked as `private`
- Types: PascalCase with `I` prefix for interfaces (optional)

## Debugging Tips

### Backend WebSocket Issues
- Check 3CX connection: `logWithTimestamp()` in webSocketManager.ts
- Verify OAuth token: tokenManager.ts handles refresh
- Monitor Redis persistence: Use Redis Commander at localhost:8081

### Frontend Real-time Updates Not Working
- Inspect WebSocket connection in browser DevTools
- Check if backend is broadcasting updates correctly
- Verify useConnectBonsaleWebHookWebSocket hook is initialized

### Call Recording Issues
- Check Bonsale API connectivity in services/api/bonsale.ts
- Verify environment variables are loaded
- Monitor call status updates in project.ts logging

### Build Failures
- Run `pnpm run type-check` to identify type errors
- Clear turbo cache: `pnpm run clean`
- Verify monorepo linkage: `pnpm install`

## Deployment Checklist

Before deploying to production:
- [ ] Update version in root package.json and README.md
- [ ] Create new Docker images with updated version tags
- [ ] Push images to GCP Container Registry
- [ ] Update `.env` with production credentials
- [ ] Test with `docker-compose.prod.yml` locally
- [ ] Run `pnpm run type-check` on all packages
- [ ] Verify all pre-commit hooks pass: `pnpm run lint && pnpm run type-check`
- [ ] Deploy to GCP VM: pull images and run docker-compose up

## Version Management

Current version: v1.0.0 (see package.json and README.md)

Recent improvements:
- Fixed cross-day call restriction validation (callRestriction logic)
- Implemented comprehensive README with public-safe environment variables
- Enhanced logging for debugging campaign execution
- Automatic recovery mechanism for projects on restart

## Additional Resources

- README.md - Complete deployment and usage guide
- .env.example - Template for environment variables
- Each app has its own package.json with specific dependencies
- Turbo documentation: Configuration in turbo.json for build caching
- Docker Compose documentation: For orchestration configuration
