#!/bin/bash

# Kill the server
pkill -f "node server.js"

# Also kill by port as backup
lsof -ti:3000 | xargs kill -9 2>/dev/null

echo "✅ Server stopped"

