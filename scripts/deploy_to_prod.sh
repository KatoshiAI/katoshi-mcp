#!/bin/bash

# Deploy dev branch to production (main)
# This script merges dev into main and pushes to trigger Cloudflare Pages deployment

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Deploying dev to production...${NC}\n"

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Not in a git repository${NC}"
    exit 1
fi

# Check if there are uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}❌ Error: You have uncommitted changes${NC}"
    echo -e "${YELLOW}Please commit or stash your changes before deploying${NC}"
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
echo -e "${BLUE}📍 Current branch: ${CURRENT_BRANCH}${NC}"

# Fetch latest from origin
echo -e "\n${BLUE}📥 Fetching latest changes from origin...${NC}"
git fetch origin

# Check if dev branch exists
if ! git show-ref --verify --quiet refs/heads/dev; then
    echo -e "${RED}❌ Error: dev branch not found locally${NC}"
    exit 1
fi

# Check if main branch exists
if ! git show-ref --verify --quiet refs/heads/main; then
    echo -e "${RED}❌ Error: main branch not found locally${NC}"
    exit 1
fi

# Make sure dev is up to date
echo -e "\n${BLUE}🔄 Updating dev branch...${NC}"
git checkout dev
git pull origin dev

# Switch to main
echo -e "\n${BLUE}🔄 Switching to main branch...${NC}"
git checkout main

# Pull latest main
echo -e "\n${BLUE}📥 Pulling latest main...${NC}"
git pull origin main

# Check if dev is ahead of main
DEV_COMMITS=$(git rev-list --count main..dev 2>/dev/null || echo "0")
MAIN_COMMITS=$(git rev-list --count dev..main 2>/dev/null || echo "0")

if [ "$DEV_COMMITS" -eq "0" ]; then
    echo -e "\n${YELLOW}⚠️  No new commits in dev to merge${NC}"
    echo -e "${YELLOW}   dev is already up to date with main${NC}"
    exit 0
fi

echo -e "\n${BLUE}📊 Merge preview:${NC}"
echo -e "   ${GREEN}Commits in dev not in main: ${DEV_COMMITS}${NC}"
if [ "$MAIN_COMMITS" -gt "0" ]; then
    echo -e "   ${YELLOW}Commits in main not in dev: ${MAIN_COMMITS}${NC}"
    echo -e "   ${YELLOW}⚠️  Main has commits that dev doesn't have${NC}"
fi

# Attempt merge
echo -e "\n${BLUE}🔀 Merging dev into main...${NC}"
if git merge dev --no-edit; then
    echo -e "${GREEN}✅ Merge successful!${NC}"
else
    echo -e "\n${RED}❌ Merge conflict detected!${NC}"
    echo -e "${YELLOW}Please resolve conflicts manually:${NC}"
    echo -e "   1. Resolve conflicts in the files listed above"
    echo -e "   2. Run: git add ."
    echo -e "   3. Run: git commit"
    echo -e "   4. Run: git push origin main"
    exit 1
fi

# Push to main
echo -e "\n${BLUE}📤 Pushing to main (triggers Cloudflare deployment)...${NC}"
if git push origin main; then
    echo -e "\n${GREEN}✅ Successfully pushed to main!${NC}"
    echo -e "${GREEN}🚀 Cloudflare Pages will now build and deploy to production${NC}"
    echo -e "\n${BLUE}💡 Next steps:${NC}"
    echo -e "   • Check Cloudflare Pages dashboard for deployment status"
    echo -e "   • Monitor the build logs"
    echo -e "   • Test your production site once deployed"
else
    echo -e "\n${RED}❌ Failed to push to main${NC}"
    exit 1
fi

# Switch back to dev branch
echo -e "\n${BLUE}🔄 Switching back to dev branch...${NC}"
git checkout dev

echo -e "\n${GREEN}✨ Deployment process complete!${NC}"

