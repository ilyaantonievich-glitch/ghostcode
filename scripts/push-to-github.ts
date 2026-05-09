#!/bin/bash
# Push to GitHub - Run this script

# Create new repo on GitHub first at: https://github.com/new
# Then run this script with your repo URL:
# ./scripts/push-to-github.sh https://github.com/YOUR_USERNAME/ghostcode.git

REPO_URL=${1:-https://github.com/anomalyco/ghostcode.git}

echo "Initializing git and pushing to $REPO_URL"

git init
git add .
git commit -m "Initial commit - GHOSTCODE with chat server"

git remote add origin $REPO_URL
git branch -M main
git push -u origin main

echo "Done! Now deploy to Railway."
echo "1. Go to https://railway.com/new"
echo "2. Select 'Deploy from GitHub' and choose this repo"
echo "3. After deploy, update .opencode/opencode.jsonc with your server URL"