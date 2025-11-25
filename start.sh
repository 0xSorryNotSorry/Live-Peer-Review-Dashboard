#!/bin/bash

# Kill any existing server on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null

# Wait a moment
sleep 1

# Start the server in background and save logs
npm run server > server.log 2>&1 &

# Get the process ID
SERVER_PID=$!

echo "🚀 Server started (PID: $SERVER_PID)"
echo "📊 Running at http://localhost:3000"
echo "📝 Logs: tail -f server.log"
echo ""
echo "To stop: ./stop.sh"

