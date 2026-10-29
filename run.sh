#!/usr/bin/env bash
# Interactive setup: asks for the folder to index and how to run Ollama, starts
# ragbox with Docker Compose, and prints the MCP endpoint.
set -euo pipefail

cd "$(dirname "$0")"

MODEL=embeddinggemma-2
NATIVE_OLLAMA=http://localhost:11434

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    %s%s%s\n' "$YELLOW" "$1" "$RESET"; }
fail() { printf '\n%sError: %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# ask VAR "Question" "default"
ask() {
  local answer
  read -r -e -p "    $2${3:+ [$3]}: " answer || exit 1
  printf -v "$1" '%s' "${answer:-$3}"
}

# confirm "Question" y|n -> exit status 0 for yes
confirm() {
  local answer hint='y/N'
  [ "$2" = y ] && hint='Y/n'
  read -r -p "    $1 [$hint]: " answer || exit 1
  answer=$(printf '%s' "${answer:-$2}" | tr '[:upper:]' '[:lower:]')
  [ "$answer" = y ] || [ "$answer" = yes ]
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

compose() { docker compose -f "$COMPOSE_YML" "$@"; }

# True if the port is published by this project's ragbox container, which `up` replaces.
port_is_ours() {
  local ours
  ours=$(compose ps -q ragbox 2>/dev/null)
  [ -n "$ours" ] && [ "$(docker ps -q --no-trunc --filter "publish=$1")" = "$ours" ]
}

has_model() { curl -fsS "$1/api/tags" 2>/dev/null | grep -q "\"$MODEL:"; }

printf '%sragbox setup%s\n' "$BOLD" "$RESET"
info "This wizard starts ragbox in Docker and connects it to an embedding model."

# --- Docker -----------------------------------------------------------------
step "Checking Docker"
command -v docker >/dev/null || fail "Docker isn't installed. Get it from https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || fail "Docker isn't running. Start Docker and run this script again."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 isn't available. Update Docker to a recent version."
command -v curl >/dev/null || fail "curl isn't installed."
info "${GREEN}Docker is ready.${RESET}"

# --- Documents folder -------------------------------------------------------
step "Folder to index"
info "ragbox mounts this folder read-only and indexes every supported file in it."
while :; do
  ask DOCS "Path" "${RAGBOX_DOCS:-$PWD/docs}"
  case "$DOCS" in "~"*) DOCS="$HOME${DOCS#\~}" ;; esac
  if [ -d "$DOCS" ]; then
    DOCS=$(cd "$DOCS" && pwd -P)
    break
  fi
  warn "Folder not found: $DOCS"
done
info "Indexing ${BOLD}$DOCS${RESET}"

# --- Ollama -----------------------------------------------------------------
step "Embedding model"
info "ragbox uses Ollama to run $MODEL, which embeds text, images, and audio."
detected=n
if command -v ollama >/dev/null || curl -fsS "$NATIVE_OLLAMA/api/version" >/dev/null 2>&1; then
  detected=y
  info "Found Ollama on this computer."
fi
if confirm "Do you already have Ollama installed?" "$detected"; then
  COMPOSE_YML=docker-compose.yml
  curl -fsS "$NATIVE_OLLAMA/api/version" >/dev/null 2>&1 ||
    fail "Ollama isn't responding at $NATIVE_OLLAMA. Start Ollama and run this script again."
  if has_model "$NATIVE_OLLAMA"; then
    info "${GREEN}$MODEL is already downloaded.${RESET}"
  else
    info "$MODEL isn't downloaded yet (about 1.3 GB)."
    confirm "Download it now?" y || fail "ragbox needs $MODEL. Run: ollama pull $MODEL"
    if command -v ollama >/dev/null; then
      ollama pull "$MODEL"
    else
      curl -fsS "$NATIVE_OLLAMA/api/pull" -d "{\"model\":\"$MODEL\",\"stream\":false}" >/dev/null ||
        fail "Downloading $MODEL failed."
    fi
  fi
  if [ "$(uname -s)" = Linux ]; then
    warn "On Linux, Ollama must accept connections from Docker containers."
    warn "If ragbox reports that Ollama is unreachable, set OLLAMA_HOST=0.0.0.0 for the Ollama service."
  fi
else
  COMPOSE_YML=docker-compose.ollama.yml
  info "ragbox will run its own Ollama container and download $MODEL on first start."
  if [ "$(uname -s)" = Darwin ]; then
    warn "Docker on macOS can't use the GPU, so embedding runs on the CPU and is slower."
    warn "For faster indexing, install Ollama from https://ollama.com/download and run this script again."
  fi
fi

# --- Port -------------------------------------------------------------------
step "Port"
PORT=${RAGBOX_HOST_PORT:-8080}
while :; do
  ask PORT "Port for the web interface and MCP endpoint" "$PORT"
  case "$PORT" in '' | *[!0-9]*) warn "Enter a number." && continue ;; esac
  if port_in_use "$PORT" && ! port_is_ours "$PORT"; then
    warn "Port $PORT is used by another program. Choose a different port."
    continue
  fi
  break
done

# --- Start ------------------------------------------------------------------
export RAGBOX_DOCS="$DOCS" RAGBOX_HOST_PORT="$PORT"

step "Starting ragbox"
if [ "$COMPOSE_YML" = docker-compose.ollama.yml ]; then
  # Download the model in the foreground so the progress is visible.
  compose up -d --wait ollama
  compose exec $([ -t 0 ] || echo -T) ollama ollama pull "$MODEL"
fi
compose up -d --build --remove-orphans

step "Waiting for ragbox"
URL="http://localhost:$PORT"
for _ in $(seq 1 60); do
  curl -fsS "$URL/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$URL/healthz" >/dev/null 2>&1 || fail "ragbox didn't start. See the logs: docker compose -f $COMPOSE_YML logs ragbox"

provider_ok() { curl -fsS "$URL/api/status" 2>/dev/null | grep -q '"provider":{"ok":true'; }
for _ in $(seq 1 30); do
  provider_ok && break
  sleep 2
done
if provider_ok; then
  info "${GREEN}ragbox is running and connected to Ollama.${RESET}"
else
  warn "ragbox is running, but it can't reach Ollama yet."
  warn "Check the error on the web interface: $URL"
fi

# --- Summary ----------------------------------------------------------------
cat <<EOF

${BOLD}ragbox is ready.${RESET}

  Web interface   $URL
  MCP endpoint    $URL/mcp

${BOLD}Add ragbox to Claude Code:${RESET}

  claude mcp add --transport http ragbox $URL/mcp

${BOLD}Other MCP clients${RESET} ${DIM}(JSON configuration)${RESET}:

  {
    "mcpServers": {
      "ragbox": { "type": "http", "url": "$URL/mcp" }
    }
  }

${DIM}Stop ragbox:     docker compose -f $COMPOSE_YML down
View the logs:   docker compose -f $COMPOSE_YML logs -f ragbox${RESET}
EOF
