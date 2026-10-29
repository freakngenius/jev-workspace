#!/bin/sh
# Builds "Jev Workspace.app" into ~/Applications: a Dock icon and a window for this project's local server.
# Run it again after moving the project folder or changing how node is installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
project=$(cd "$here/.." && pwd)
dest="${JEV_APP_DIR:-$HOME/Applications}"
app="$dest/Jev Workspace.app"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Drawing the icon"
swiftc -O "$here/make-icon.swift" -o "$work/make-icon"
"$work/make-icon" "$work/icon.png"
mkdir "$work/AppIcon.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/icon.png" --out "$work/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$work/icon.png" --out "$work/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$work/AppIcon.iconset" -o "$work/AppIcon.icns"

echo "Compiling the app"
swiftc -O "$here/JevWorkspace.swift" -o "$work/JevWorkspace"

echo "Installing $app"
mkdir -p "$dest"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$work/JevWorkspace" "$app/Contents/MacOS/JevWorkspace"
cp "$work/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cp "$here/Info.plist" "$app/Contents/Info.plist"
# An app opened from the Dock gets a bare PATH, so save one that finds node (npm's own entries left out).
node -e '
const path = require("node:path");
const dirs = [path.dirname(process.execPath), ...(process.env.PATH || "").split(":")].filter((d) => d && !d.includes("node_modules"));
process.stdout.write(JSON.stringify({ project: process.argv[1], path: [...new Set(dirs)].join(":") }));
' "$project" > "$app/Contents/Resources/config.json"
codesign --force --sign - "$app"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$app" || true
echo "Installed $app"
