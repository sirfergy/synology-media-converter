#!/bin/sh

if [ "$USE_VAAPI" = "true" ]; then
    if [ -e /dev/dri/renderD128 ]; then
        echo "Setting permissions for VAAPI device"
        chmod 755 /dev/dri/renderD128
    else
        echo "VAAPI device not found, disabling hardware acceleration"
        echo "In Docker make sure to pass through the device with --device /dev/dri/renderD128"
        unset USE_VAAPI
    fi
fi

if [ "$SINGLE_RUN" != "true" ]; then
    if [ -z "${CRON_INTERVAL+x}" ]; then
        CRON_INTERVAL="0 1 * * *"
    fi
    echo "$CRON_INTERVAL /app/run-converter.sh" > /etc/crontabs/root
    crond -f
else
    /app/run-converter.sh "$@"
fi