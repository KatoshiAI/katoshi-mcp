#!/bin/bash

# AWS Lambda Layer Builder using Docker for Node.js
# This script creates a Lambda layer package using Amazon Linux Docker container
# to ensure maximum compatibility with AWS Lambda environment

set -e  # Exit on any error

# Cleanup function
cleanup() {
    rm -f Dockerfile
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
    docker rmi lambda-layer-builder-node 2>/dev/null || true
}
trap cleanup EXIT

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NODE_VERSION="22"  # AWS Lambda's supported Node.js version (matches .nvmrc)
CONTAINER_NAME="lambda-layer-builder-node"

# Parse architecture argument
ARCH="${1:-arm64}"  # Default to arm64
if [[ "$ARCH" != "x86_64" && "$ARCH" != "arm64" ]]; then
    echo -e "${RED}ERROR: Invalid architecture '$ARCH'. Use 'x86_64' or 'arm64'${NC}"
    exit 1
fi

# Create deployments directory if it doesn't exist
mkdir -p deployments

OUTPUT_NAME="deployments/lambda-layer-nodejs-${ARCH}.zip"

# Set Docker image and platform based on architecture
if [[ "$ARCH" == "arm64" ]]; then
    DOCKER_IMAGE="public.ecr.aws/lambda/nodejs:${NODE_VERSION}-arm64"
    PLATFORM="linux/arm64"
else
    DOCKER_IMAGE="public.ecr.aws/lambda/nodejs:${NODE_VERSION}"
    PLATFORM="linux/amd64"
fi

echo -e "${BLUE}📦 Building Katoshi MCP Server Lambda Layer using Docker${NC}"
echo -e "${BLUE}Node.js Version: $NODE_VERSION${NC}"
echo -e "${BLUE}Target Architecture: $ARCH${NC}"
echo "=============================================="

# Check if Docker is installed and running
if ! command -v docker &> /dev/null; then
    echo -e "${RED}ERROR: Docker is not installed${NC}"
    echo "Please install Docker Desktop for Mac from https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}ERROR: Docker daemon is not running${NC}"
    echo "Please start Docker Desktop"
    exit 1
fi

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo -e "${RED}ERROR: package.json not found. Run this script from the project root.${NC}"
    exit 1
fi

# Clean up any existing container with the same name
echo -e "${YELLOW}Cleaning up any existing containers...${NC}"
docker rm -f "$CONTAINER_NAME" &> /dev/null || true

# Clean up any previous builds
if [[ -f "$OUTPUT_NAME" ]]; then
    echo -e "${YELLOW}Removing existing $OUTPUT_NAME${NC}"
    rm "$OUTPUT_NAME"
fi

# Create Dockerfile
echo -e "${YELLOW}Creating Dockerfile...${NC}"
cat << EOF > Dockerfile
FROM ${DOCKER_IMAGE}

# Install required tools
RUN microdnf update -y && \
    microdnf install -y \
    zip \
    && microdnf clean all

# Create standard Lambda layer directory structure for Node.js
RUN mkdir -p /opt/nodejs

# Copy package.json and package-lock.json if they exist
COPY package*.json /opt/nodejs/

# Install Node.js dependencies to /opt/nodejs (standard Lambda layer path)
WORKDIR /opt/nodejs
RUN if [ -f package-lock.json ]; then \
        npm ci --only=production --no-audit --no-fund; \
    else \
        npm install --only=production --no-audit --no-fund; \
    fi

# Clean up to reduce layer size
RUN find /opt/nodejs/node_modules -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type f -name "*.pyc" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type f -name "*.pyo" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type d -name "test" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type d -name "examples" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -type d -name "example" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "*.md" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "*.rst" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "LICENSE*" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "README*" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "CHANGELOG*" -delete 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name ".github" -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name ".nyc_output" -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/nodejs/node_modules -name "coverage" -type d -exec rm -rf {} + 2>/dev/null || true

# Create zip file from /opt directory (Lambda standard)
WORKDIR /opt
RUN zip -r /lambda-layer.zip .

# Set CMD to make the container runnable
CMD ["echo", "Lambda layer created successfully"]
EOF

# Build Docker image
echo -e "${YELLOW}Building Docker image...${NC}"
if command -v docker buildx &> /dev/null && docker buildx version &> /dev/null; then
    docker buildx build --platform ${PLATFORM} -t lambda-layer-builder-node . || {
        echo -e "${RED}Failed to build Docker image with buildx${NC}"
        exit 1
    }
else
    echo -e "${YELLOW}buildx not available, using standard docker build${NC}"
    docker build --platform ${PLATFORM} -t lambda-layer-builder-node . || {
        echo -e "${RED}Failed to build Docker image${NC}"
        exit 1
    }
fi

# Run container and create the layer
echo -e "${YELLOW}Running container to create layer...${NC}"
docker run --platform ${PLATFORM} --name "$CONTAINER_NAME" --entrypoint="" lambda-layer-builder-node /bin/true || {
    echo -e "${RED}Failed to run container${NC}"
    exit 1
}

# Copy zip file from container
echo -e "${YELLOW}Copying layer from container...${NC}"
docker cp "$CONTAINER_NAME:/lambda-layer.zip" "$OUTPUT_NAME" || {
    echo -e "${RED}Failed to copy layer from container${NC}"
    docker rm "$CONTAINER_NAME"
    exit 1
}

# Clean up (handled by trap, but explicit cleanup here too)
echo -e "${YELLOW}Cleaning up...${NC}"
cleanup

# Get ZIP file size
ZIP_SIZE=$(du -h "$OUTPUT_NAME" | cut -f1)
ZIP_SIZE_MB=$(du -m "$OUTPUT_NAME" | cut -f1)

# Check AWS Lambda limits
if [[ $ZIP_SIZE_MB -gt 50 ]]; then
    echo -e "${RED}ERROR: ZIP size (${ZIP_SIZE}) exceeds Lambda's 50MB compressed limit${NC}"
    exit 1
elif [[ $ZIP_SIZE_MB -gt 40 ]]; then
    echo -e "${YELLOW}Warning: ZIP size (${ZIP_SIZE}) is approaching Lambda's 50MB limit${NC}"
fi

echo -e "${GREEN}✅ Lambda layer created successfully!${NC}"
echo -e "${GREEN}📁 File: $OUTPUT_NAME${NC}"
echo -e "${GREEN}📏 Size: $ZIP_SIZE${NC}"

echo ""
echo -e "${BLUE}🚀 Quick Deploy Instructions:${NC}"
echo "1. Go to AWS Lambda Console"
echo "2. Layers → Create layer"
echo "3. Upload $OUTPUT_NAME"
echo "4. Set compatible runtimes to Node.js ${NODE_VERSION}.x"
echo "5. Set compatible architecture to ${ARCH}"
echo "6. Create and note the Layer ARN"
echo "7. Attach the layer to your Lambda function"

echo ""
echo -e "${BLUE}📋 Or use AWS CLI:${NC}"
echo "aws lambda publish-layer-version \\"
echo "  --layer-name katoshi-mcp-server-layer \\"
echo "  --zip-file fileb://$OUTPUT_NAME \\"
echo "  --compatible-runtimes nodejs${NODE_VERSION}.x \\"
echo "  --compatible-architectures ${ARCH}"

echo ""
echo -e "${BLUE}🎯 Usage in Lambda Function:${NC}"
echo "1. Create your function using build_lambda_function.sh"
echo "2. Attach this layer to your function"
echo "3. Your function code will automatically have access to node_modules"
echo "4. No need to include dependencies in your function ZIP"

echo -e "${GREEN}🎉 Done!${NC}"