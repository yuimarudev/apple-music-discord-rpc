#!/bin/sh -xe
# cd to project root
cd "$(dirname "$0")"
cd ..

DENO_PATH="$(which deno)"
if [ -z "$DENO_PATH" ]; then
  echo --- Deno not found. Please install Deno first and add it to your PATH.
  exit 1
fi
DENO_PATH_DIR="$(dirname "$DENO_PATH")"

./scripts/uninstall.sh

echo "Enter the publicly accessible URL of the server that will host your local album artwork (leave blank if not):"
read url
echo "Enter the port of the server that hosts the local file album artwork (leave blank if not):"
read port

echo --- Copy launch agent plist
mkdir ~/Library/LaunchAgents/ || true
cp -f scripts/moe.yuru.music-rpc.plist ~/Library/LaunchAgents/
echo --- Edit launch agent plist
# /usr/bin is for osascript
plutil -replace EnvironmentVariables.PATH -string "$DENO_PATH_DIR:/usr/bin" ~/Library/LaunchAgents/moe.yuru.music-rpc.plist
plutil -replace EnvironmentVariables.ARTWORK_SERVER_PORT -string "$port" ~/Library/LaunchAgents/moe.yuru.music-rpc.plist
plutil -replace EnvironmentVariables.ARTWORK_SERVER_BASEURL -string "$url" ~/Library/LaunchAgents/moe.yuru.music-rpc.plist
plutil -replace WorkingDirectory -string "$(pwd)" ~/Library/LaunchAgents/moe.yuru.music-rpc.plist
echo --- Load launch agent
launchctl load ~/Library/LaunchAgents/moe.yuru.music-rpc.plist
echo --- INSTALL SUCCESS
