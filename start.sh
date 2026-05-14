#!/bin/bash
# HyperEdit Startup Script for Ubuntu 26.04
# Starts both backend (FFmpeg server) and frontend (Vite dev server)

set -e

echo "=========================================="
echo "  HyperEdit - AI Video Editor"
echo "  Starting services..."
echo "=========================================="

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required. Install it with: sudo apt install nodejs"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg is required. Install it with: sudo apt install ffmpeg"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ERROR: ffprobe is required (part of ffmpeg)."; exit 1; }

# Get the directory where this script is located
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Install dependencies if needed
if [ ! -d "frontend/node_modules" ] || [ ! -d "backend/node_modules" ]; then
    echo ""
    echo "[SETUP] Installing dependencies..."
    
    if [ ! -d "frontend/node_modules" ]; then
        echo "[SETUP] Installing frontend dependencies..."
        cd frontend && npm install --legacy-peer-deps && cd ..
    fi
    
    if [ ! -d "backend/node_modules" ]; then
        echo "[SETUP] Installing backend dependencies..."
        cd backend && npm install && cd ..
    fi
    
    echo "[SETUP] Dependencies installed."
fi

# Source environment variables
if [ -f "backend/.dev.vars" ]; then
    echo ""
    echo "[ENV] Loading backend environment variables..."
    export $(grep -v '^\s*#' backend/.dev.vars | xargs)
fi

# Create temp directory for FFmpeg
mkdir -p /tmp/hyperedit-ffmpeg

echo ""
echo "=========================================="
echo "  Starting backend on port 3333..."
echo "=========================================="
cd backend
node scripts/local-ffmpeg-server.js &
BACKEND_PID=$!
cd ..

# Wait for backend to be ready
sleep 2

echo ""
echo "=========================================="
echo "  Starting frontend on port 5173..."
echo "=========================================="
cd frontend
npx vite --host 0.0.0.0 --port 5173 &
FRONTEND_PID=$!
cd ..

echo ""
echo "=========================================="
echo "  HyperEdit is running!"
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:3333"
echo ""
echo "  Press Ctrl+C to stop all services"
echo "=========================================="

# Trap SIGINT/SIGTERM to kill both processes
trap "echo 'Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

# Wait for either process to exit
wait
