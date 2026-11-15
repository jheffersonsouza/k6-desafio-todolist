#!/bin/sh
# Roda os testes com Docker: ./run.sh [comando]. Sem comando, roda o "dev". Lista de comandos: ./run.sh ajuda
# Os gráficos ficam no painel: http://localhost:3030
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Criei o .env a partir do .env.example. Confira API e BASE_URL."
fi

# Valor de uma variável: do ambiente, se tiver, senão do .env.
setting() {
  value=$(printenv "$1" || true)
  [ -n "$value" ] || value=$(sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r')
  printf '%s' "${value:-$2}"
}

# Sobe o painel (Grafana e InfluxDB) se ainda não estiver de pé. Na primeira vez baixa as imagens.
start_panel() {
  log=$(mktemp)
  if ! docker compose up -d --quiet-pull grafana >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
}

command=${1:-dev}
case "$command" in
  painel)
    echo "Subindo o painel (na primeira vez baixa as imagens, pode demorar)..."
    start_panel
    echo "Painel: http://localhost:3030"
    (xdg-open http://localhost:3030 || open http://localhost:3030) >/dev/null 2>&1 &
    exit 0
    ;;
  parar)
    # Para só o teste; o painel continua no ar.
    for id in $(docker ps -q --filter label=com.docker.compose.project=k6-desafio-todolist --filter label=com.docker.compose.service=k6); do
      docker stop "$id" >/dev/null
    done
    exit 0
    ;;
  desligar) exec docker compose down ;;
  dev | capacidade | resistencia) ;;
  *) exec docker compose run --rm --no-deps -e UTC_OFFSET="$(date +%z)" k6 "$@" ;;
esac

api=$(setting API api | tr -c 'A-Za-z0-9_.-' '_')
name="${api}_${command}_$(date +%Y-%m-%d-%H-%M-%S)"
case "$command" in dev) kind="rápido" ;; resistencia) kind="resistência" ;; *) kind=$command ;; esac
label="$api · $kind · $(date '+%d/%m %H:%M')"
flag="results/.medindo-$name"

echo "Subindo o painel (na primeira vez baixa as imagens, pode demorar)..."
start_panel

# Mede memória e CPU da API em segundo plano enquanto o teste roda.
touch "$flag"
sh scripts/medir.sh "$(setting BASE_URL http://host.docker.internal:8080)" "results/$name.recursos.csv" "$flag" "$api" "$name" "$label" >/dev/null 2>&1 &
sampler=$!

# Ctrl+C para o teste, mas o script continua para montar o relatório com o que já foi medido.
trap ':' INT TERM
status=0
docker compose run --rm --no-deps --service-ports -e API="$api" -e RUN_NAME="$name" -e RUN_LABEL="$label" k6 "$command" || status=$?
rm -f "$flag"
wait "$sampler" 2>/dev/null || true
trap - INT TERM

if [ -f "results/$name.json" ]; then
  docker compose run --rm --no-deps -e UTC_OFFSET="$(date +%z)" -e RUN_LABEL="$label" k6 relatorio "$name" || true
fi
rm -f "results/$name.recursos.csv"
exit "$status"
