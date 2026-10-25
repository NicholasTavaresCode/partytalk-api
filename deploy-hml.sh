#!/usr/bin/env bash
# Deploy partytalk-api to Cloud Run — HML (partytalk-hml).
#
#   ./deploy-hml.sh
#
# The wait is Cloud Build, not this script: `--source .` uploads the repo (filtered by
# .gcloudignore — no node_modules, dist or .env), builds the Dockerfile, pushes the
# image, then deploys. Three to six minutes is normal, and it is all the last command.
#
# APIs are enabled below on every run. One-time prerequisites, none created here — gcloud
# (or the Firestore check below) reports a missing one clearly:
#   - Firestore: the database "$FIRESTORE_DATABASE_ID" (Standard edition, Native mode, nam5),
#     created in the console.
#   - $SERVICE_ACCOUNT, used for BOTH the build and the runtime — of this service and of
#     partytalk-web, which deploys as the same account — with:
#       roles/datastore.user            Firestore (runtime)
#       roles/aiplatform.user           Gemini on Vertex AI (runtime)
#       roles/logging.logWriter         runtime AND build logs — without it the service
#                                       runs and Cloud Logging stays empty
#       roles/storage.objectUser        read the uploaded source (build)
#       roles/artifactregistry.writer   push the image (build)
#   - OAuth client (Google Auth Platform): $FRONTEND_URL in Authorized JavaScript
#     origins; while the app is in "Testing", every tester in Audience → test users.
# The very first `--source` deploy creates the `cloud-run-source-deploy` image repository
# the web deploy also pushes to — so the first time, deploy this API before the web.
# After that the order does not matter: both URLs are deterministic, so each side is
# configured against the other up front.

set -euo pipefail

PROJECT_ID=partytalk-hml
PROJECT_NUMBER=484961620847
REGION=us-central1
# The named Firestore database HML uses (multi-region nam5, created in the console). The
# API opens "(default)" unless FIRESTORE_DATABASE_ID says otherwise, so this is set below.
FIRESTORE_DATABASE_ID=partytalk
SERVICE_NAME=partytalk-api
# A service account email is @PROJECT_ID, never @PROJECT_NUMBER — the number form
# belongs only to Google-managed default accounts.
SERVICE_ACCOUNT=partytalk-api-hml@${PROJECT_ID}.iam.gserviceaccount.com

# No custom DNS. Cloud Run URLs are deterministic: https://SERVICE-PROJECTNUMBER.REGION.run.app
SELF_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
# The deployed web app — the only browser origin allowed by CORS. Unlike a cookie-based
# setup there is no proxy in between: the browser calls this API directly with a Google
# ID token as `Authorization: Bearer`, so the two run.app hosts being different sites is
# fine. (Socket.IO's own CORS is open; the handshake is authenticated by token instead.)
FRONTEND_URL="https://partytalk-web-${PROJECT_NUMBER}.${REGION}.run.app"

# Must be the exact client the web build uses (NEXT_PUBLIC_GOOGLE_CLIENT_ID there): every
# ID token is verified with this as its audience. A mismatch is a 401 on every call, and
# the API log names the `aud` claim. Same client as local dev; HML only adds its origin.
GOOGLE_OAUTH_CLIENT_ID=484961620847-joi2l06qeuem1ocna1fnt4n907j8gp7g.apps.googleusercontent.com

# HML is reachable by anyone who finds the URL. Only these Google accounts may use it;
# every other verified account is refused with 403 before a user record is created.
# Add a tester here (and to the OAuth "Audience" test users), then redeploy — it is read
# at boot. Comma-separated, case-insensitive.
ALLOWED_AUTH_EMAILS="nicholasbalby@gmail.com,nicholasbalby@hotmail.com"

# One flag with a custom '|' delimiter, because some values contain commas.
ENV_VARS="^|^NODE_ENV=production"
ENV_VARS+="|CORS_ORIGINS=$FRONTEND_URL"
ENV_VARS+="|GCP_PROJECT_ID=$PROJECT_ID"
# No GOOGLE_APPLICATION_CREDENTIALS: on Cloud Run, ADC is $SERVICE_ACCOUNT itself — for
# Firestore and for Vertex AI alike. No FIRESTORE_EMULATOR_HOST: the real database.
ENV_VARS+="|FIRESTORE_DATABASE_ID=$FIRESTORE_DATABASE_ID"
ENV_VARS+="|GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
ENV_VARS+="|ALLOWED_AUTH_EMAILS=$ALLOWED_AUTH_EMAILS"
# Explicit, so a stray local value can never reach HML. `true` would let anyone call every
# REST route as one shared dev user.
ENV_VARS+="|AUTH_DISABLED=false"
# What local dev runs today; `global` is the endpoint the 3.x Flash-Lite models are on.
ENV_VARS+="|VERTEX_LOCATION=global"
ENV_VARS+="|VERTEX_HOST_MODEL=gemini-3.5-flash-lite"
ENV_VARS+="|VERTEX_SCORING_MODEL=gemini-3.5-flash-lite"
# The AI facilitator's cadence — the knobs that bound Gemini spend per room.
ENV_VARS+="|ROOM_SUGGEST_EVERY_SEGMENTS=8"
ENV_VARS+="|ROOM_SILENCE_MS=25000"
ENV_VARS+="|ROOM_CONTEXT_SEGMENTS=25"
ENV_VARS+="|LOG_LEVEL=info"
# Exactly one proxy — Cloud Run's front end — sits between browsers and this process, so
# the client IP is the last X-Forwarded-For hop. Without it every request seems to come
# from the proxy and all users share ONE rate-limit budget (100 req/min): a single busy
# tab, or a bot hitting this public URL, would 429 every tester.
ENV_VARS+="|TRUST_PROXY_HOPS=1"
# PORT is not set on purpose: Cloud Run reserves it and injects 8080, which main.ts reads.

# Voice relay (optional). Wired automatically when a static address named `partytalk-turn`
# exists in $REGION — a coturn server in `use-auth-secret` mode whose shared secret is in
# Secret Manager as PARTYTALK_TURN_SECRET, readable by $SERVICE_ACCOUNT. Without it,
# browsers get STUN only. Its shared secret is the only secret this API
# holds: verifying Google ID tokens needs only the public client id, and every GCP call
# authenticates as the service account. --quiet: never stop on an "enable API?" prompt.
TURN_IP=$(gcloud compute addresses describe partytalk-turn --region "$REGION" --project "$PROJECT_ID" \
  --format='value(address)' --quiet 2>/dev/null || true)
EXTRA_FLAGS=()
if [[ -n "$TURN_IP" ]]; then
  ENV_VARS+="|TURN_URLS=turn:${TURN_IP}:3478?transport=udp,turn:${TURN_IP}:3478?transport=tcp"
  EXTRA_FLAGS+=(--set-secrets="TURN_SECRET=PARTYTALK_TURN_SECRET:latest")
fi

# Enable everything this deploy and the running service use, so gcloud never stops at an
# "API not enabled — enable and retry?" prompt halfway through. A few seconds when they
# are already on; a minute or two the first time.
REQUIRED_APIS=(
  run.googleapis.com              # Cloud Run — this service
  cloudbuild.googleapis.com       # builds the Dockerfile uploaded by `--source .`
  artifactregistry.googleapis.com # stores the built image
  firestore.googleapis.com        # runtime: rooms, users, transcripts
  aiplatform.googleapis.com       # runtime: Gemini (AI host + reports)
  secretmanager.googleapis.com    # runtime: TURN_SECRET, when a relay is configured
  logging.googleapis.com          # build and runtime logs
)
echo "Enabling required APIs…"
gcloud services enable "${REQUIRED_APIS[@]}" --project "$PROJECT_ID"

# The Firestore database is created by hand in the console (see the top).
# Without it the service would deploy, pass its liveness probe, and then fail every room
# and sign-in call — so stop here instead.
if ! FIRESTORE_TYPE=$(gcloud firestore databases describe --database="$FIRESTORE_DATABASE_ID" \
  --project "$PROJECT_ID" --format='value(type)' --quiet 2>&1); then
  if [[ "$FIRESTORE_TYPE" == *NOT_FOUND* || "$FIRESTORE_TYPE" == *"does not exist"* ]]; then
    echo "No Firestore database \"$FIRESTORE_DATABASE_ID\" in $PROJECT_ID. Create it, then re-run:"
    echo "  https://console.cloud.google.com/firestore/databases?project=$PROJECT_ID"
    echo "  Database ID $FIRESTORE_DATABASE_ID · Standard edition, Native mode · location nam5"
  else
    echo "Couldn't check Firestore (an API enabled seconds ago can take a minute):"
    echo "$FIRESTORE_TYPE"
  fi
  exit 1
fi
if [[ "$FIRESTORE_TYPE" != FIRESTORE_NATIVE ]]; then
  echo "Firestore database \"$FIRESTORE_DATABASE_ID\" is in $FIRESTORE_TYPE — the API needs Native mode."
  exit 1
fi

echo "Deploying $SERVICE_NAME to $PROJECT_ID/$REGION — the build takes a few minutes."

# --max-instances 1 is NOT a capacity choice. The facilitator's per-room counters and
# silence timers, and the voice mesh's signaling membership, live in this process. A
# second instance would split a room's sockets between processes: peers on different
# instances could never relay WebRTC offers to each other, and each would run its own
# topic triggers. Raising it needs a shared store (Redis) first.
#
# --timeout 3600: a WebSocket is one long-lived request to Cloud Run, so the request
# timeout is the socket's lifetime. At 60s every client would be cut off each minute (and
# reconnect, rebuilding its voice mesh). 3600 is Cloud Run's maximum; Socket.IO
# reconnects transparently when even that expires.
#
# --session-affinity: Socket.IO opens with HTTP long-polling and upgrades to WebSocket;
# both legs must reach the same instance. Moot at one instance, but it keeps that true
# the day the cap is lifted.
#
# --concurrency 200: every connected participant holds one request slot for as long as
# their socket is open, on top of their REST calls. 80 would cap HML at ~16 full rooms.
#
# --allow-unauthenticated is deliberate: browsers call this directly, and every route
# except the health probes is authenticated in-app by GoogleAuthGuard + the allow-list.
#
# --cpu-boost: full CPU during startup, so a cold start (min-instances 0) serves its first
# request — usually someone opening a room — faster.
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --service-account "$SERVICE_ACCOUNT" \
  --build-service-account "projects/$PROJECT_ID/serviceAccounts/$SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --session-affinity \
  --concurrency 200 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --cpu-boost \
  --set-env-vars="$ENV_VARS" \
  ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}

echo
echo "Live:    $SELF_URL/api/v1   (browser origin allowed: $FRONTEND_URL)"
if [[ -n "$TURN_IP" ]]; then
  echo "Voice:   STUN + TURN relay at $TURN_IP"
else
  echo "Voice:   STUN only (no partytalk-turn relay address in $REGION)"
fi
echo "Health:  curl $SELF_URL/api/v1/health/ready"
echo "Swagger: $SELF_URL/docs"
echo "Logs:    gcloud run services logs tail $SERVICE_NAME --region $REGION --project $PROJECT_ID"
