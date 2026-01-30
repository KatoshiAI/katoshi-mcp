# Katoshi MCP Server

A Model Context Protocol (MCP) server that transforms your existing APIs into MCP tools, deployable on [Railway](https://railway.app).

## Overview

This project provides:
- **MCP Server Implementation**: Converts your APIs into MCP-compatible tools
- **HTTP server**: Long-running server (e.g. on Railway) with JSON-RPC 2.0 over HTTP
- **Easy Tool Registration**: Simple pattern to add new API tools

## Architecture

```
AI Agent → Railway (HTTP) → MCP Server → Your APIs
```

The MCP server implements the JSON-RPC 2.0 protocol over HTTP, making it compatible with MCP clients and AI agents.

## Quick Start

### Prerequisites

- Node.js 22+ (use `nvm use` to select the correct version)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

### Local Development

Run the server locally for testing:

```bash
npm run dev
```

This starts a local development server. You can test it with:

```bash
# Health check
curl http://localhost:3000/health

# List tools
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'

# Call a tool
curl -X POST http://localhost:3000 \
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
  }'
```

## Adding Your APIs as MCP Tools

### Step 1: Create a Tool File

Create a new file in `src/` (e.g., `src/user-apis.ts`):

```typescript
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Your API function
async function getUserProfile(args: Record<string, unknown>): Promise<string> {
  const userId = args.userId as string;
  
  // Call your actual API
  const response = await fetch(`https://your-api.com/users/${userId}`, {
    headers: {
      "Authorization": `Bearer ${process.env.API_KEY}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  return JSON.stringify(data);
}

// Export as MCP tool
export const userApiTools: Tool[] = [
  {
    name: "get_user_profile",
    description: "Get user profile information by user ID",
    inputSchema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "The unique identifier of the user",
        },
      },
      required: ["userId"],
    },
    handler: getUserProfile,
  },
];
```

### Step 2: Register the Tools

Add your tools to `src/tools.ts`:

```typescript
import { userApiTools } from "./user-apis.js";

export const apiTools: Tool[] = [
  ...exampleApiTools,
  ...userApiTools, // Add your tools here
];
```

### Step 3: Rebuild and Deploy

```bash
npm run build
# Deploy via Railway (see below) or your own host
```

## Deployment to Railway

Deploy by connecting your GitHub repo to Railway; pushes to your chosen branch will trigger automatic builds and deploys. No deploy scripts are required.

### 1. Connect GitHub to Railway

1. Sign in at [railway.app](https://railway.app) and create a new project.
2. Click **Add Service** → **GitHub Repo** and select this repository.
3. Choose the branch to deploy (e.g. `main`).
4. Railway will detect Node.js and use:
   - **Build**: `npm run build`
   - **Start**: `npm start` (runs `node dist/index.js`)

The server listens on the `PORT` environment variable that Railway sets automatically.

### 2. Environment Variables

In your Railway service → **Variables**, add any env vars your tools need, for example:

- `API_KEY` – if your tools call external APIs
- `API_BASE_URL` – base URL for your APIs
- Any other keys your `src/tools` use

### 3. Get Your URL

After the first deploy, Railway assigns a public URL (e.g. `https://your-app.up.railway.app`). You can add a custom domain in the service settings.

### 4. Connecting from another Railway service (same project)

When another service in the same Railway project connects to this MCP server, use the **private URL** and **include the port**:

- In the other service’s variables, set e.g. `KATOSHI_MCP_URL=https://katoshi-mcp.railway.internal:PORT` where `PORT` is the port Railway assigns this MCP service (often `8080` or the value of `PORT` in this service). Example: `https://katoshi-mcp.railway.internal:8080/?id=USER_ID`.
- If you omit the port, the client may connect to the wrong port and fail (connection errors, timeouts, or “No response returned”).

## API Usage

### MCP Protocol Endpoints

Replace `https://your-app.up.railway.app` with your Railway (or local) URL.

**List Available Tools:**
```bash
POST https://your-app.up.railway.app/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

**Call a Tool:**
```bash
POST https://your-app.up.railway.app/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_user_by_id",
    "arguments": {
      "userId": "123"
    }
  }
}
```

**Health Check:**
```bash
GET https://your-app.up.railway.app/health
```

### Connecting from Cursor IDE

Cursor IDE supports connecting to remote MCP servers using the `mcp-remote` package. This allows you to use your deployed MCP server directly in Cursor.

#### Step 1: Create MCP Configuration

Create or edit the MCP configuration file. Cursor looks for MCP configuration in:
- **Global**: `~/.cursor/mcp.json` (applies to all workspaces)
- **Workspace**: `.cursor/mcp.json` in your project root (workspace-specific)

#### Step 2: Add Your Server Configuration

Add the following configuration to your `mcp.json` file:

```json
{
  "mcpServers": {
    "katoshi": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR_RAILWAY_URL?id=USER_ID&api_key=API_KEY"
      ]
    }
  }
}
```

**Replace the placeholders:**
- `USER_ID`: Your user ID
- `API_KEY`: Your API key

**Note:** The `mcp-remote` package will be automatically installed via `npx` when Cursor connects, so you don't need to install it globally.

#### Step 3: Restart Cursor

After adding the configuration, restart Cursor IDE to load the MCP server connection.

#### Example Configuration File

Copy the example configuration and customize it with your credentials:

```bash
# For workspace-specific configuration
mkdir -p .cursor
cat > .cursor/mcp.json << 'EOF'
{
  "mcpServers": {
    "katoshi": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR_RAILWAY_URL?id=YOUR_USER_ID&api_key=YOUR_API_KEY"
      ]
    }
  }
}
EOF

# Or for global configuration (applies to all workspaces)
mkdir -p ~/.cursor
cat > ~/.cursor/mcp.json << 'EOF'
{
  "mcpServers": {
    "katoshi": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR_RAILWAY_URL?id=YOUR_USER_ID&api_key=YOUR_API_KEY"
      ]
    }
  }
}
EOF
```

Replace `YOUR_USER_ID` and `YOUR_API_KEY` with your actual credentials.

### Connecting from Other AI Agents

Most MCP clients support HTTP transport. Configure your client with:

- **URL**: Your Railway (or other) endpoint URL
- **Transport**: HTTP
- **Protocol**: JSON-RPC 2.0

Example for Claude Desktop (if supported):
```json
{
  "mcpServers": {
    "katoshi": {
      "url": "https://your-app.up.railway.app/",
      "transport": "http"
    }
  }
}
```

## Project Structure

```
katoshi-mcp/
├── index.ts                 # HTTP server entry (Railway / local)
├── src/
│   ├── tools.ts             # Tool types + registry (combines all tools)
│   ├── mcp-server.ts        # MCP server implementation
│   ├── katoshi-tools.ts     # Katoshi trading tools
│   ├── hyperliquid-tools.ts # Hyperliquid API tools (optional)
│   ├── request-context.ts   # Request context (apiKey, userId)
│   └── utils.ts             # Logging and helpers
├── mcp.json.example         # Example Cursor MCP configuration
├── package.json
└── tsconfig.json
```

## Troubleshooting

### MCP Connection Issues in Cursor

If you encounter errors when connecting to the MCP server in Cursor (such as `Cannot find module 'math-intrinsics/abs'`), this is usually due to a Node.js version mismatch. The `mcp-remote` package requires Node.js 22 or higher.

**Solution: Update Node.js Version**

1. Ensure Node.js 22+ is installed and set as default:
```bash
# Using nvm (recommended)
nvm install 22
nvm use 22
nvm alias default 22

# Or download from https://nodejs.org/
```

2. Clear the npx cache to remove cached packages from older Node versions:
```bash
rm -rf ~/.npm/_npx
```

3. Restart Cursor IDE

**Verify Node.js Version**

Check your Node.js version:
```bash
node -v  # Should show v22.x.x or higher
```

If you're using nvm, make sure it's loaded in your shell profile (`.zshrc`, `.bashrc`, etc.):
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

### CORS Issues

The server sends permissive CORS headers by default. To restrict origins in production, change `CORS_HEADERS` in `index.ts` (e.g. set `Access-Control-Allow-Origin` to your frontend origin).

### Railway Logs

In the Railway dashboard, open your service → **Deployments** → select a deployment → **View Logs** to see stdout/stderr.

## Security

1. **API Keys**: Store in Railway Variables (or another secrets manager); never commit keys.
2. **CORS**: Restrict allowed origins in production (see above).
3. **Authentication**: MCP requests require an API key via `Authorization: Bearer`, `X-Api-Key`, or `api_key` query param; backend validates on first tool call.

## Next Steps

- [ ] Replace example APIs with your actual APIs
- [ ] Add authentication/authorization as needed
- [ ] Add monitoring and alerting (e.g. Railway metrics or external APM)
- [ ] Configure custom domain in Railway

## Resources

- [MCP Specification](https://modelcontextprotocol.io/)
- [Railway Docs](https://docs.railway.app/)

## License

MIT

