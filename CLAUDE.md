# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

### Development
```bash
pnpm install              # Install all dependencies
pnpm dev                  # Run backend & frontend in dev mode
pnpm backend              # Run backend only (Node.js on port 4020)
pnpm frontend             # Run frontend only (Vite on port 4030)
pnpm type-check           # TypeScript validation across all packages
pnpm lint                 # ESLint check
pnpm lint:fix             # ESLint with auto-fix
```

### Docker (Local Development)
```bash
pnpm docker:up            # Start docker-compose (backend + frontend + redis)
pnpm docker:down          # Stop docker-compose
docker-compose logs -f    # View live logs
```

### Build & Test
```bash
pnpm build                # Build all packages (Turbo orchestrated)
pnpm test                 # Run tests
pnpm clean                # Clean build artifacts
```

### Single Package Commands
```bash
# Backend (apps/backend/)
pnpm -F backend dev       # Backend dev server with auto-reload
pnpm -F backend build     # Compile TypeScript to dist/

# Frontend (apps/frontend/)
pnpm -F frontend dev      # Frontend dev with HMR
pnpm -F frontend build    # Production build
```

## Project Architecture

### Technology Stack
- **Frontend**: React 19 + Vite + TypeScript + Material-UI 7
- **Backend**: Node.js 18+ + Express + TypeScript + WebSocket (ws)
- **Data**: Redis 7 (state & cache) + async-mutex (concurrency)
- **Build**: Turbo monorepo + pnpm workspaces
- **Deployment**: Docker + Docker Compose + GCP Container Registry

### Monorepo Structure
```
apps/backend/           # Express API server
  - src/class/         # Core business logic (Project, ProjectManager, etc.)
  - src/services/      # Redis, API integrations (3CX, Bonsale, xApi)
  - src/routes/        # HTTP endpoints
  - src/websockets/    # WebSocket connection handlers
  - src/types/         # Domain-specific interfaces

apps/frontend/         # React web dashboard
  - src/components/    # React UI components
  - src/pages/         # Page-level components
  - src/router/        # React Router setup
  - src/theme/         # Material-UI theme

packages/shared-types/ # Shared TypeScript definitions
  - ApiResponse<T>, User, Auth types
  - WebSocket event types
```

### High-Level Architecture

This is a **real-time outbound campaign management system** integrating:
1. **3CX Phone System**: WebSocket connection for live call monitoring/control
2. **Bonsale CRM**: API integration for contact management and configurations
3. **Campaign Dashboard**: Real-time UI for viewing/controlling active campaigns

**Key Pattern**: The `Project` class (src/class/project.ts) is the heart of the system, managing a single campaign's full lifecycle:
- 3CX WebSocket connection (connect → authenticate → listen for calls)
- Call list processing and dialing
- Call state tracking (ringing → connected → completed)
- Bonsale CRM updates on call completion
- Automatic recovery on connection loss

The backend exposes this via WebSocket events, allowing the frontend to view/control projects in real-time.

### State Management
- **In-Memory**: Active Project instances maintain state during operation
- **Redis**: Persistent storage of project state (survives restarts with `AUTO_RECOVER_ON_RESTART=true`)
- **Bonsale**: CRM source of truth for contacts and call outcomes

## Core Components to Know

### Backend

**`Project` class** (`src/class/project.ts`, ~95KB)
- Manages a single outbound campaign lifecycle
- Connects to 3CX, monitors calls, dials contacts, updates CRM
- Complex state machine with concurrency control (mutex)
- Implements: token refresh, call restrictions (time/extension), idle checks, auto-recovery

**`ProjectManager`** (`src/class/projectManager.ts`)
- Registry of active Project instances
- Lifecycle operations: create, stop, remove, recover from Redis

**`WebSocketManager`** (`src/class/webSocketManager.ts`)
- Manages WebSocket server connections and message broadcasting
- Two endpoints: main WS server + Bonsale webhook listener

**`redis.ts`** (`src/services/redis.ts`)
- Redis client initialization and cache operations
- Persistence layer for project state

**API Services** (`src/services/api/`)
- `bonsale.ts`: Contact retrieval, campaign config
- `callControl.ts`: 3CX call operations (dial, hangup, transfer)
- `xApi.ts`: Token refresh from 3CX authentication

### Frontend
- **Router setup** determines page layout
- **Real-time updates** via WebSocket message events
- **Material-UI theme** in `src/theme/` for consistent styling

## Important Patterns & Conventions

### Error Handling
**Error Serialization Issue**: When Error objects are serialized to JSON, they lose properties (stack, name become empty).
- Solution: Check `/docs/ERROR_HANDLING.md` for proper error handling
- Use `error instanceof Error` checks and extract properties before serialization
- Always wrap token refresh failures with proper error context

### WebSocket Protocol
- **Format**: `{ event: string, payload: any }`
- **Server responses**: Include `timestamp` in payload
- **Event examples**: `startOutbound`, `stopOutbound`, `allProjects`
- See `/docs/WEBSOCKET_FORMAT.md` for complete specification

### Concurrency Control
- `async-mutex` protects critical sections in Project class
- Example: Token refresh and call state updates are mutex-protected
- **Important**: Ensure all async operations within mutex blocks complete properly (avoid deadlocks)

### Call Restrictions
- **Time-based**: Campaign only dials during specified UTC time windows
- **Extension cooldown**: Extensions have min interval between consecutive calls
- **Cross-day ranges**: Restrictions can span midnight (e.g., 22:00-06:00)

### TypeScript Paths
- `@/*` → Backend: `apps/backend/src/*`
- `@shared/*` → Backend: `../../packages/shared-types/src/*`
- Frontend imports from `packages/shared-types` directly

## Environment Configuration

Create `.env` at root with:
```
# 3CX Integration
HTTP_HOST_3CX=https://your-3cx-host:5015
WS_HOST_3CX=wss://your-3cx-host:5015
ADMIN_3CX_CLIENT_ID=xxx
ADMIN_3CX_CLIENT_SECRET=xxx

# Application
HTTP_PORT=4020
NODE_ENV=development

# Bonsale CRM
BONSALE_HOST=https://your-bonsale-host
BONSALE_X_API_KEY=xxx
BONSALE_X_API_SECRET=xxx

# Redis
REDIS_URL=redis://localhost:6379

# Features
AUTO_RECOVER_ON_RESTART=true
IS_STARTIDLECHECK=true

# Idle Check Intervals (ms)
IDLE_CHECK_INTERVAL=300000
MIN_IDLE_CHECK_INTERVAL=30000
MAX_IDLE_CHECK_INTERVAL=300000
IDLE_CHECK_BACKOFF_FACTOR=1.5
```

## Development Workflow

1. **Start development environment**: `pnpm docker:up` (backend + frontend + redis)
2. **Or run individually**: `pnpm backend` + `pnpm frontend` in separate terminals
3. **Watch changes**: Turbo caching auto-rebuilds dependencies
4. **Check types**: `pnpm type-check` catches TypeScript errors early
5. **Lint before commit**: Git hooks run `lint-staged` via Husky

### Debugging Tips
- **Backend logs**: Check `docker-compose logs backend` for real-time logs
- **Redis state**: Use `redis-commander` (port 8081) to inspect Redis data
- **Frontend console**: Browser DevTools > Console for client-side errors
- **WebSocket events**: Monitor network tab for WebSocket frames

## Testing

- Backend uses Jest (minimal test setup currently)
- No dedicated frontend test suite yet
- Focus on type safety (`pnpm type-check`) as primary quality gate

## Deployment

### Local Docker
```bash
docker-compose up --build
```

### Production (GCP)
1. Build and push images to GCP Container Registry:
   ```bash
   docker build --platform linux/amd64 -f apps/backend/Dockerfile \
     -t gcr.io/PROJECT/bonsale_3cx-outbound-campaign_backend:latest .
   docker push gcr.io/PROJECT/bonsale_3cx-outbound-campaign_backend:latest
   ```
2. Deploy via GCP Cloud Run or Kubernetes using `docker-compose.prod.yml` as reference

See `/README.md` for comprehensive deployment guide (in Chinese).

## Key Files Reference

| File | Purpose |
|------|---------|
| `apps/backend/src/app.ts` | Express app setup, route mounting, WebSocket initialization |
| `apps/backend/src/class/project.ts` | Campaign lifecycle, 3CX integration, call processing |
| `apps/backend/src/class/projectManager.ts` | Project registry and lifecycle |
| `apps/backend/src/services/redis.ts` | Redis client, state persistence |
| `apps/frontend/src/main.tsx` | React entry point |
| `packages/shared-types/src/index.ts` | Shared types and interfaces |
| `docs/WEBSOCKET_FORMAT.md` | WebSocket protocol specification |
| `docs/ERROR_HANDLING.md` | Error serialization patterns |

## Notes for Future Development

- **Project class is complex**: Consider breaking into smaller focused classes as it grows
- **Error handling**: Always check `/docs/ERROR_HANDLING.md` before serializing Errors
- **Token refresh**: Mutex deadlock prevention is critical (see TokenManager)
- **Scaling**: Redis persistence enables horizontal scaling of campaign instances
- **Type safety**: Leverage shared-types to ensure frontend/backend consistency
