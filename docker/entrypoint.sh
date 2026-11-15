#!/bin/sh
# Ponto de entrada do compose.yaml: docker compose run --rm --service-ports k6 <comando>
# Também funciona com o k6 instalado na máquina: BASE_URL=http://localhost:8080 API=java sh run.sh <comando>
set -eu

usage() {
  cat <<'EOF'
Uso: docker compose run --rm --service-ports k6 <comando>

  contract                   só o teste de contrato
  smoke                      contrato + carga mínima (padrão)
  load | stress | spike |    contrato + teste de carga, com gráficos ao vivo
  soak | breakpoint          em http://localhost:5665 e relatório HTML em results/
  compare <a.json> <b.json>  compara dois resultados de results/
EOF
}

command="${1:-smoke}"
case "$command" in
  contract)
    exec k6 run contract.js
    ;;
  smoke | load | stress | spike | soak | breakpoint)
    if [ "${SKIP_CONTRACT:-}" != "1" ] && ! k6 run --quiet contract.js; then
      echo "O contrato falhou: veja os [MUST] acima. Corrija a API ou rode com SKIP_CONTRACT=1." >&2
      exit 1
    fi
    # O smoke é curto demais para o dashboard gerar relatório.
    if [ "$command" != smoke ]; then
      export K6_WEB_DASHBOARD=true
      export K6_WEB_DASHBOARD_PERIOD=2s
      export K6_WEB_DASHBOARD_EXPORT="results/${API:-api}_${command}_$(date -u +%Y-%m-%d-%H-%M-%S).html"
      echo "Gráficos ao vivo em http://localhost:5665"
    fi
    k6 run -e PROFILE="$command" load.js && status=0 || status=$?
    if [ -f "${K6_WEB_DASHBOARD_EXPORT:-}" ]; then
      echo "Relatório com gráficos: ${K6_WEB_DASHBOARD_EXPORT} (abra no navegador)"
    fi
    exit "$status"
    ;;
  compare)
    if [ $# -ne 3 ]; then
      usage
      exit 2
    fi
    exec k6 run --quiet -e A="$2" -e B="$3" compare.js
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
