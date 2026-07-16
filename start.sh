#!/usr/bin/env bash
set -e

echo
echo "  ReSplat Local Backend"
echo "  ====================="
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js is not installed."
    echo "  Please install Node.js >= 20.19.0 from https://nodejs.org/"
    echo
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  [WARN] Node.js version $NODE_VERSION detected. Recommended: >= 20.19.0"
    echo
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
fi

# Build frontend if dist/ doesn't exist
if [ ! -f "dist/index.html" ]; then
    echo "  Building frontend..."
    npm run build
fi

# Start server
echo "  Starting ReSplat backend..."
echo
npm run local
