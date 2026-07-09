FROM alpine:latest

ARG TARGETPLATFORM

RUN apk add --no-cache tzdata nodejs npm ffmpeg imagemagick libheif
RUN if [ "$TARGETPLATFORM" = "linux/amd64" ]; then \
        apk add --no-cache libva-intel-driver mesa-va-gallium; \
    fi

COPY . /app
WORKDIR /app
RUN npm install --omit=dev
RUN npm test
RUN chmod +x entrypoint.sh run-converter.sh

ENTRYPOINT ["/app/entrypoint.sh"]
