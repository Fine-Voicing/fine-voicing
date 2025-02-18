#!/bin/bash
SERVICE_NAME=$1

git tag -a "deploy-$SERVICE_NAME-$(date +%Y%m%d_%H%M%S)" -m "Freezing code for deployment of $SERVICE_NAME"
git push origin deploy-$SERVICE_NAME-$(date +%Y%m%d_%H%M%S)
docker build -f Dockerfile -t fine-voicing-$SERVICE_NAME .
rm -rf deployments/*
docker save -o deployments/fine-voicing-$SERVICE_NAME.tar fine-voicing-$SERVICE_NAME
scp deployments/fine-voicing-$SERVICE_NAME.tar fv-queue:~/fv-outbound-calls
scp .env.production fv-queue:~/fv-outbound-calls
scp docker-compose.yml fv-queue:~/fv-outbound-calls
ssh fv-queue "docker load -i fv-outbound-calls/fine-voicing-$SERVICE_NAME.tar"
ssh fv-queue "cd fv-outbound-calls && docker compose up -d --force-recreate $SERVICE_NAME"
