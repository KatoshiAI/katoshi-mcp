# Katoshi MCP Server

A Model Context Protocol (MCP) server that transforms your existing APIs into MCP tools, deployable on AWS Lambda with API Gateway.

## Overview

This project provides:
- **MCP Server Implementation**: Converts your APIs into MCP-compatible tools
- **AWS Lambda Handler**: Serverless deployment on AWS
- **API Gateway Integration**: HTTP endpoint for AI agents to connect
- **Easy Tool Registration**: Simple pattern to add new API tools

## Architecture

```
AI Agent → API Gateway → Lambda Function → MCP Server → Your APIs
```

The MCP server implements the JSON-RPC 2.0 protocol over HTTP, making it compatible with MCP clients and AI agents.

## Quick Start

### Prerequisites

- Node.js 22+ (use `nvm use` to select the correct version)
- AWS CLI configured

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

Create a new file in `src/tools/` (e.g., `src/tools/user-apis.ts`):

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

Add your tools to `src/tools/index.ts`:

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
npm run deploy
```

## Deployment to AWS

### Manual Deployment (Recommended - No SAM Required)

This project includes scripts for manual deployment without requiring AWS SAM.

#### Step 1: Build and Package Lambda Function

```bash
# Build TypeScript and create Lambda package
npm run package

# This creates: deployments/lambda-function.zip
```

#### Step 2: Create Lambda Function

**Option A: Using AWS Console**
1. Go to AWS Lambda Console
2. Create Function → Upload from .zip file
3. Upload `deployments/lambda-function.zip`
4. Set handler to: `index.handler`
5. Set runtime to: Node.js 22.x
6. Set timeout to 30+ seconds
7. Set memory to 512+ MB

**Option B: Using AWS CLI**
```bash
aws lambda create-function \
  --function-name katoshi-mcp-server \
  --runtime nodejs22.x \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --handler index.handler \
  --zip-file fileb://deployments/lambda-function.zip \
  --timeout 30 \
  --memory-size 512
```

#### Step 3: Set Up API Gateway

**Option A: Using the Setup Script**
```bash
./scripts/setup_api_gateway.sh katoshi-mcp-server
```

**Option B: Manual Setup via AWS Console**
1. Go to API Gateway Console
2. Create API → HTTP API
3. Add integration → Lambda function → Select your function
4. Configure routes:
   - `POST /` - for MCP protocol messages
   - `GET /health` - for health checks
   - `OPTIONS /{proxy+}` - for CORS
5. Deploy to a stage (e.g., `dev`)

#### Step 4: Update Function Code (for updates)

```bash
# Rebuild and package
npm run package

# Update function
aws lambda update-function-code \
  --function-name katoshi-mcp-server \
  --zip-file fileb://deployments/lambda-function.zip
```

### Environment Variables

Set environment variables in the AWS Lambda Console:

1. Go to AWS Lambda Console → Your Function → Configuration → Environment variables
2. Add variables like:
   - `API_KEY`: your-api-key
   - `API_BASE_URL`: https://your-api.com

Or use AWS CLI:
```bash
aws lambda update-function-configuration \
  --function-name katoshi-mcp-server \
  --environment "Variables={API_KEY=your-key,API_BASE_URL=https://your-api.com}"
```

For production, use AWS Systems Manager Parameter Store or Secrets Manager and reference them in your Lambda function code.

## API Usage

### MCP Protocol Endpoints

**List Available Tools:**
```bash
POST https://your-api-gateway-url/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

**Call a Tool:**
```bash
POST https://your-api-gateway-url/
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
GET https://your-api-gateway-url/health
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
        "https://mcp.katoshi.ai?id=USER_ID&api_key=API_KEY"
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
        "https://mcp.katoshi.ai?id=YOUR_USER_ID&api_key=YOUR_API_KEY"
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
        "https://mcp.katoshi.ai?id=YOUR_USER_ID&api_key=YOUR_API_KEY"
      ]
    }
  }
}
EOF
```

Replace `YOUR_USER_ID` and `YOUR_API_KEY` with your actual credentials.

### Connecting from Other AI Agents

Most MCP clients support HTTP transport. Configure your client with:

- **URL**: Your API Gateway endpoint URL
- **Transport**: HTTP
- **Protocol**: JSON-RPC 2.0

Example for Claude Desktop (if supported):
```json
{
  "mcpServers": {
    "katoshi": {
      "url": "https://your-api-gateway-url/",
      "transport": "http"
    }
  }
}
```

## Project Structure

```
katoshi-mcp/
├── src/
│   ├── index.ts             # AWS Lambda entry point (handler)
│   ├── mcp-server.ts        # MCP server implementation
│   └── tools/
│       ├── index.ts         # Tool registry
│       ├── example-apis.ts  # Example tools
│       └── ...              # Your API tools
├── scripts/
│   ├── build_lambda_function.sh  # Package Lambda function
│   └── build_lambda_layer.sh     # Build Lambda layer (for dependencies)
├── deployments/             # Build output directory
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

### Lambda Timeout

If your API calls take too long, increase the timeout in AWS Lambda Console:

1. Go to AWS Lambda Console → Your Function → Configuration → General configuration
2. Click Edit → Increase Timeout (e.g., 60 seconds)

Or use AWS CLI:
```bash
aws lambda update-function-configuration \
  --function-name katoshi-mcp-server \
  --timeout 60
```

### CORS Issues

CORS is configured in API Gateway. To restrict origins:

1. Go to API Gateway Console → Your API → CORS
2. Update Allowed Origins to your domain(s)
3. Redeploy the API

### Debugging

Check CloudWatch Logs:
```bash
aws logs tail /aws/lambda/katoshi-mcp-server-mcp-server --follow
```

## Cost Optimization

- **Lambda**: Pay per request (very cheap for low traffic)
- **API Gateway**: Pay per million requests
- **Cold Starts**: First request may be slower (~1-2s), subsequent requests are fast

For high traffic, consider:
- Provisioned concurrency (reduces cold starts)
- API Gateway caching
- CloudFront CDN in front of API Gateway

## Security

1. **API Keys**: Store in AWS Secrets Manager or Parameter Store
2. **CORS**: Restrict allowed origins in production
3. **Rate Limiting**: Add API Gateway throttling
4. **Authentication**: Add API key or JWT validation in Lambda handler

## Next Steps

- [ ] Replace example APIs with your actual APIs
- [ ] Add authentication/authorization
- [ ] Set up CI/CD pipeline
- [ ] Add monitoring and alerting
- [ ] Configure custom domain for API Gateway

## Resources

- [MCP Specification](https://modelcontextprotocol.io/)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)

## License

MIT

