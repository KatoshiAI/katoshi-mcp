#!/bin/bash
# Simple test script for MCP server
# Usage: ./test-mcp.sh <api-gateway-url>

API_URL="${1:-http://localhost:3000}"

echo "Testing MCP Server at: $API_URL"
echo ""

# Health check
echo "1. Health Check:"
curl -s "$API_URL/health" | jq '.' || echo "Health check failed"
echo ""
echo ""

# List tools
echo "2. List Tools:"
curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }' | jq '.' || echo "List tools failed"
echo ""
echo ""

# Call a tool
echo "3. Call Tool (get_user_by_id):"
curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_user_by_id",
      "arguments": {
        "userId": "123"
      }
    }
  }' | jq '.' || echo "Call tool failed"
echo ""

