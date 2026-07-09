# synology-media-converter

> [!NOTE]
> This project is not officially affiliated with Synology.

Since DSM version 7.2.2 Synology has removed the ability to generate thumbnails, transcode videos to H264 and display HEIC files in Synology Photos due to licensing restrictions. As an official solution they provide a tool called Synology Image Assistant which requires a computer and is only available for Windows and macOS. This project aims to restore the old way how Photos worked by providing a script that can be directly run on the NAS (or any other device that supports Docker) and automatically converts newly added media every night.

## Installation

**Container Manager:**\
You can easily install the service via the [Container manager](https://www.synology.com/de-de/dsm/feature/container-manager) by importing the file `ContainerManager_synology-media-converter.json` in the GUI. By default the script expects there to be a volume called docker that contains the `synology-media-converter.json` config described in [Configuration](#configuration). You can edit the host volume path at the very bottom of the preset file before importing it.

**Docker CLI:**
```bash
docker run -d --name=synology-media-converter \
    --network=host \
    -v <config_file>:/app/config.json \
    -v <state_directory>:/app/tmp \
    -e TZ=<timezone>
    -e CRON_INTERVAL="0 1 * * *" \
    -e USE_VAAPI=true \
    --device /dev/dri/renderD128 \
    ghcr.io/1randomdev/synology-media-converter
```

## Configuration
Example config for 2 users on the same device:
```json
{
    "accounts": [
        {
            "url": "http://192.168.1.10:5000",
            "username": "user1",
            "password": "secret"
        },
        {
            "url": "http://192.168.1.10:5000",
            "username": "user2",
            "password": "secret"
        }
    ]
}
```

## Environment Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| TZ | Current timezone, necessary for crontab to use the correct time. [List](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) of supported Timezones. | UTC |
| CRON_INTERVAL | Crontab interval that defines how often the script will be executed. [Crontab Generator](https://crontab.guru/) | `0 1 * * *` (Every day at 1am) |
| SINGLE_RUN | Only run the script once instead of using cron. Auto restart of the container must be disabled. | false |
| EXIT_ON_FAIL | Exit on conversion errors instead of permanently marking the affected file as broken. Usually only used for testing purposes. | false |
| USE_VAAPI | Enable hardware acceleration via VAAPI. For more info see [Hardware Acceleration](#hardware-acceleration). | false |
| REPAIR_LIMIT | Maximum number of existing HEIC/HEIF photos to repair in one manual run. `0` repairs all pending candidates. | 0 |

## Repairing Existing Image Thumbnails

Image thumbnails created before the resize fix can be regenerated with:

```bash
docker exec synology-media-converter \
    /app/run-converter.sh --repair-images
```

Repair mode is manual and never runs from the nightly cron. It processes HEIC
and HEIF photos sequentially through Synology Photos' regeneration API and
stores resumable progress in `/app/tmp`, which must be a persistent volume.
Live Photos are skipped by the first repair release. The first run records an
index-time cutoff; if Synology later reindexes the library, remove the repair
state files before starting a new repair pass.
Use a small pilot before a full repair:

```bash
docker exec -e REPAIR_LIMIT=10 synology-media-converter \
    /app/run-converter.sh --repair-images
```

The converter's normal and repair modes share a non-blocking file lock, so a
nightly run exits without doing work while repair mode is active. When running
repair mode from another host, stop the NAS converter first because file locks
are not shared between hosts.

## Hardare Acceleration
Hardware transcoding to x264 is currently supported on Intel and AMD Graphics using VAAPI, which is what's available on most DiskStation models. To enable hardware acceleration add the environment variable `USE_VAAPI=true` and pass through the VAAPI device via `--device /dev/dri/renderD128`. The right permissions will be set automatically on startup.
