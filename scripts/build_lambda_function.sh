#!/bin/bash

# AWS Lambda Function Builder for Katoshi MCP Server
# This script packages the Lambda function code (compiled TypeScript from dist/)
# Since we have no dependencies, we don't need a Lambda layer

echo "📦 Creating Katoshi MCP Server Lambda Function"
echo "=============================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ package.json not found. Run this script from the project root."
    exit 1
fi

# Check if dist directory exists and has been built
if [ ! -d "dist" ]; then
    echo "❌ dist directory not found. Please run 'npm run build' first."
    exit 1
fi

if [ ! -f "dist/index.js" ]; then
    echo "❌ dist/index.js not found. Please run 'npm run build' first."
    exit 1
fi

if [ ! -d "dist/src" ]; then
    echo "❌ dist/src directory not found. Please run 'npm run build' first."
    exit 1
fi

# Create deployments directory if it doesn't exist
mkdir -p deployments

# Create temp directory for packaging
TEMP_DIR="lambda_package_temp"
echo "📦 Creating temporary directory..."
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# Copy compiled JavaScript files from dist directory
echo "📦 Copying compiled Lambda function code..."
# Copy package.json with "type": "module" for ES modules support
echo '{"type":"module"}' > "$TEMP_DIR/package.json"
# Copy index.js (handler) to root - only .js files needed for Lambda
cp dist/index.js "$TEMP_DIR/"
# Copy src folder - only .js files needed
mkdir -p "$TEMP_DIR/src"
find dist/src -name "*.js" -type f | while read file; do
    rel_path=${file#dist/}
    mkdir -p "$TEMP_DIR/$(dirname "$rel_path")"
    cp "$file" "$TEMP_DIR/$rel_path"
done

# List contents for verification
echo "📦 Package contents:"
ls -la "$TEMP_DIR"
echo "📦 Lambda handler:"
ls -la "$TEMP_DIR/index.js" 2>/dev/null || echo "⚠️  index.js not found!"

# Create zip from temp directory
echo "📦 Creating zip package..."
rm -f deployments/lambda-function.zip
cd "$TEMP_DIR"
zip -r ../deployments/lambda-function.zip . \
    -x "*/node_modules/*" \
    -x "*/.git/*" \
    -x "*/test*" \
    -x "*/example*" \
    -x "*/__pycache__/*" \
    -x "*.pyc" \
    -x "*.pyo" \
    -x "*.log"
cd ..

# Verify zip contents
echo "📦 Verifying zip contents..."
unzip -l deployments/lambda-function.zip | head -20

# Cleanup
rm -rf "$TEMP_DIR"

# Check file size
ZIP_SIZE=$(du -h deployments/lambda-function.zip | cut -f1)
ZIP_SIZE_MB=$(du -m deployments/lambda-function.zip | cut -f1)

echo "✅ Lambda function packaged successfully!"
echo "📁 File: deployments/lambda-function.zip"
echo "📏 Size: $ZIP_SIZE"

# Check size limits
if [[ $ZIP_SIZE_MB -gt 50 ]]; then
    echo "⚠️  Warning: ZIP size (${ZIP_SIZE}) exceeds Lambda's 50MB compressed limit"
    echo "   Consider using a Lambda layer for dependencies"
elif [[ $ZIP_SIZE_MB -gt 40 ]]; then
    echo "⚠️  Warning: ZIP size (${ZIP_SIZE}) is approaching Lambda's 50MB limit"
fi

echo ""
echo "🎯 Manual Upload Instructions:"
echo "1. Go to AWS Lambda Console"
echo "2. Create Function → Upload from .zip file"
echo "3. Upload deployments/lambda-function.zip"
echo "4. Set handler to: index.handler"
echo "5. Set runtime to: Node.js 22.x"
echo "6. Configure environment variables if needed"
echo "7. Set timeout to 30+ seconds"
echo "8. Set memory to 512+ MB"
echo "9. Test your function!"

echo ""
echo "📋 Or use AWS CLI:"
echo "aws lambda create-function \\"
echo "  --function-name katoshi-mcp-server \\"
echo "  --runtime nodejs22.x \\"
echo "  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \\"
echo "  --handler index.handler \\"
echo "  --zip-file fileb://deployments/lambda-function.zip \\"
echo "  --timeout 30 \\"
echo "  --memory-size 512"

echo "🎉 Done!"