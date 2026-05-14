#!/bin/bash
set -e

MODE="${1:-dev}"  # dev or prod

echo "=========================================="
echo "  HyperEdit - AI Video Editor"
echo "  Mode: $MODE"
echo "=========================================="

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required. Install: sudo apt install nodejs"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg is required. Install: sudo apt install ffmpeg"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ERROR: ffprobe is required."; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Install dependencies if missing
if [ ! -d "frontend/node_modules" ]; then
    echo "[SETUP] Installing frontend dependencies..."
    cd frontend && npm install --legacy-peer-deps && cd ..
fi
if [ ! -d "backend/node_modules" ]; then
    echo "[SETUP] Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

# Build frontend for production
if [ "$MODE" = "prod" ]; then
    echo "[BUILD] Building frontend for production..."
    cd frontend && npm run build && cd ..
fi

# Load env vars
if [ -f "backend/.dev.vars" ]; then
    set -a; source backend/.dev.vars; set +a
fi

mkdir -p /tmp/hyperedit-ffmpeg logs

if command -v pm2 &>/dev/null && [ "$MODE" = "prod" ]; then
    echo ""
    echo "Starting with PM2..."
    pm2 start ecosystem.config.cjs
    pm2 save
    echo ""
    echo "=========================================="
    echo "  Running with PM2"
    echo "  Commands:"
    echo "    pm2 logs hyperedit-backend"
    echo "    pm2 logs hyperedit-frontend"
    echo "    pm2 stop all"
    echo "=========================================="
else
    echo ""
    echo "Starting backend on port 3333..."
    cd backend
    node scripts/local-ffmpeg-server.js &
    BACKEND_PID=$!
    cd ..

    sleep 2

    echo "Starting frontend on port 5173..."
    cd frontend
    if [ "$MODE" = "prod" ]; then
        npx vite preview --host 0.0.0.0 --port 5173 &
    else
        npx vite --host 0.0.0.0 --port 5173 &
    fi
    FRONTEND_PID=$!
    cd ..

    echo ""
    echo "=========================================="
    echo "  HyperEdit running!"
    echo "  Frontend: http://localhost:5173"
    echo "  Backend:  http://localhost:3333"
    echo "  Press Ctrl+C to stop"
    echo "=========================================="

    trap "echo 'Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM
    wait
fi
