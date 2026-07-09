#!/bin/sh

cd /app || exit 1
mkdir -p /app/tmp || exit 1
exec 9>/app/tmp/converter.lock || exit 1
if ! flock -n 9; then
    echo "Another converter process is already running; skipping this invocation."
    exit 0
fi

/usr/bin/node /app/main.js "$@"
