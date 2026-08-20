#!/bin/bash
docker buildx build --platform linux/amd64 -t "$1" --push .
