#!/bin/sh
# Serves the production build for the desktop app, rebuilding first when the code changed since the last build.
# The app runs this only when nothing already answers on 127.0.0.1:3131, and stops it on quit.
set -eu
cd "$(dirname "$0")/.."
app=$PPID

# Its own build folder, so `npm run dev` and `npm run app` keep theirs.
export NEXT_DIST_DIR=.next-app
next=node_modules/next/dist/bin/next
echo "jev: node $(node --version) in $(pwd)"

# Children run in the background so a quit (SIGINT or SIGTERM from the app) can stop them.
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 143' INT TERM
# If the app dies its end of the output pipe closes; a write must not kill this script before it cleans up.
trap '' PIPE

fresh=
if [ -f "$NEXT_DIST_DIR/BUILD_ID" ]; then
  changed=$(find app components lib public package.json package-lock.json next.config.ts postcss.config.mjs \
    -newer "$NEXT_DIST_DIR/BUILD_ID" -type f 2>/dev/null | head -n 1)
  [ -z "$changed" ] && fresh=1
fi
if [ -z "$fresh" ]; then
  echo "jev: building"
  node "$next" build &
  child=$!
  wait "$child"
fi

echo "jev: starting"
node "$next" start -H 127.0.0.1 -p 3131 &
child=$!
# If the app goes away without quitting (a crash, Force Quit), stop the server rather than leave it running.
while kill -0 "$child" 2>/dev/null; do
  if ! kill -0 "$app" 2>/dev/null; then
    kill "$child"
    wait "$child" || true
    exit 0
  fi
  sleep 1
done
wait "$child"
