#!/bin/sh
# Comandos do container do k6 (compose.yaml). No dia a dia, use o run.sh ou o run.bat.
set -eu

usage() {
  cat <<'EOF'
Comandos:
  dev            checklist da spec e teste rápido (~1 min 30 s). É o padrão.
  capacidade     sobe a carga em degraus até a API não aguentar (até ~4 min)
  resistencia    carga constante por 30 min, para ver se a memória ou a velocidade pioram
  checklist      só o checklist da spec: o que a API já faz e o que falta
  comparar A B   compara dois resultados de results/
  painel         abre o painel com os gráficos (http://localhost:3030)
  parar          para o teste que estiver rodando
  desligar       desliga o painel (o histórico fica guardado)
EOF
}

# O checklist roda sem os logs do k6: o resumo dele já mostra tudo, inclusive se a API não respondeu.
checklist() {
  k6 run --quiet --log-output=none "$@" k6/contract.js
}

# Roda o checklist antes do teste de carga e guarda o resultado, que aparece no relatório.
checklist_before() {
  if checklist -e CHECKLIST_MODO=resumo; then
    export CHECKLIST=ok
  else
    export CHECKLIST=falhou
  fi
}

# AO_VIVO=1 liga também o painel do próprio k6 em http://localhost:5665.
live() {
  if [ "${AO_VIVO:-}" = "1" ]; then
    export K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_PERIOD=2s
    echo "  Painel do k6: http://localhost:5665"
  fi
}

# Teste de carga mandando as métricas ao vivo para o painel (InfluxDB). Esconde dois avisos do k6 sobre essa
# saída: que ela vai sair na versão 3 (a versão do k6 está fixada no compose.yaml) e que o envio atrasou
# na carga mais alta (os gráficos só chegam alguns segundos depois).
load_test() {
  export K6_INFLUXDB_PUSH_INTERVAL=2s K6_INFLUXDB_CONCURRENT_WRITES=8
  fifo=$(mktemp -u)
  mkfifo "$fifo"
  while IFS= read -r line; do
    case "$line" in
      *"influxdb output has been deprecated"* | *"flush operation took higher than the expected"*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$fifo" &
  reader=$!
  k6 run --quiet --log-format raw --out influxdb=http://influxdb:8086/k6 "$@" k6/load.js >"$fifo" 2>&1 &
  pid=$!
  # Ctrl+C e o comando parar chegam neste script: repassa para o k6 encerrar e ainda salvar o resultado.
  trap 'kill -TERM "$pid" 2>/dev/null || true' INT TERM
  status=0
  wait "$pid" || status=$?
  while kill -0 "$pid" 2>/dev/null; do
    status=0
    wait "$pid" || status=$?
  done
  wait "$reader" 2>/dev/null || true
  rm -f "$fifo"
  return "$status"
}

command="${1:-dev}"
case "$command" in
  dev | capacidade | resistencia)
    checklist_before
    live
    echo "  Gráficos ao vivo: http://localhost:3030"
    load_test -e PROFILE="$command"
    ;;
  checklist)
    checklist
    ;;
  relatorio)
    if [ $# -ne 2 ]; then
      usage
      exit 2
    fi
    exec k6 run --quiet --log-output=none -e RUN_NAME="$2" k6/report.js
    ;;
  comparar)
    if [ $# -ne 3 ]; then
      usage
      exit 2
    fi
    exec k6 run --quiet -e A="$2" -e B="$3" k6/compare.js
    ;;
  ajuda | help | -h | --help)
    usage
    ;;
  *)
    echo "Comando desconhecido: $command" >&2
    usage
    exit 2
    ;;
esac
