#!/bin/sh
# Mede memória (MB) e CPU (núcleos) da API a cada segundo, enquanto o arquivo-sinal existir. Chamado pelo run.sh.
# Uso: medir.sh <BASE_URL> <arquivo.csv> <arquivo-sinal> <api> <execução> <rótulo>
# Acha a API pela porta: primeiro um container que publique a porta, depois um processo escutando nela.
# Cada amostra vai para o CSV (relatório) e para o painel (InfluxDB), se ele estiver de pé.
set -u
# Ponto como separador decimal, qualquer que seja o idioma do sistema.
export LC_ALL=C
url=$1
out=$2
flag=$3
api=$4
run=$5
# Tag do InfluxDB: espaço, vírgula e sinal de igual escapados.
label=$(printf '%s' "$6" | sed 's/[ ,=]/\\&/g')

hostport=${url#*://}
hostport=${hostport%%/*}
host=${hostport%%:*}
port=${hostport##*:}
if [ "$port" = "$hostport" ]; then
  case "$url" in https://*) port=443 ;; *) port=80 ;; esac
fi
# Só dá para medir a API se ela estiver nesta máquina.
case "$host" in localhost | 127.0.0.1 | host.docker.internal | 0.0.0.0) ;; *) exit 0 ;; esac

# $1 = tempo (s), $2 = memória (MB), $3 = CPU (núcleos)
emit() {
  echo "$1,$2,$3" >>"$out"
  ms=$(awk -v t="$1" 'BEGIN { printf "%d", t * 1000 }')
  curl -s -m 2 -o /dev/null -X POST "http://127.0.0.1:8086/write?db=k6&precision=ms" \
    --data-binary "api_recursos,api=$api,run=$run,rotulo=$label memoria_mb=$2,cpu_nucleos=$3 $ms" 2>/dev/null || true
}

container=$(docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null | head -n 1)
if [ -n "$container" ]; then
  echo "# container $container" >"$out"
  while [ -f "$flag" ]; do
    line=$(docker stats --no-stream --format '{{.MemUsage}};{{.CPUPerc}}' "$container" 2>/dev/null) || break
    [ -n "$line" ] || break
    # Ex.: "45.3MiB / 15.5GiB;12.34%"
    set -- $(echo "$line" | awk -F';' '{
      split($1, used, " "); value = used[1] + 0; unit = used[1]; sub(/^[0-9.]+/, "", unit)
      factor = (unit == "GiB" || unit == "GB") ? 1024 : (unit == "KiB" || unit == "kB") ? 1 / 1024 : (unit == "B") ? 1 / 1048576 : 1
      cpu = $2; sub(/%/, "", cpu)
      printf "%.1f %.2f", value * factor, cpu / 100
    }')
    [ $# -eq 2 ] && emit "$(date +%s)" "$1" "$2"
  done
  exit 0
fi

pid=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)
[ -n "$pid" ] || pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1)
[ -n "$pid" ] || exit 0
echo "# processo $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-60) (PID $pid)" >"$out"

if [ -r "/proc/$pid/stat" ]; then
  # Linux: memória residente do /proc/<pid>/status e CPU pela diferença de tempo de CPU do /proc/<pid>/stat.
  hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
  previous=""
  while [ -f "$flag" ] && [ -r "/proc/$pid/stat" ]; do
    now=$(date +%s.%N)
    rss=$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)
    stat=$(cat "/proc/$pid/stat" 2>/dev/null) || break
    # O nome do processo vem entre parênteses e pode ter espaço: os campos de CPU vêm depois do último ")".
    set -- ${stat##*) }
    ticks=$((${12} + ${13}))
    if [ -n "$previous" ] && [ -n "$rss" ]; then
      set -- $(echo "$now $rss $ticks $previous" | awk -v hz="$hz" '{
        elapsed = $1 - $4
        printf "%.3f %.1f %.2f", $1, $2 / 1024, (elapsed > 0 ? ($3 - $5) / hz / elapsed : 0)
      }')
      emit "$1" "$2" "$3"
    fi
    previous="$now $ticks"
    sleep 1
  done
else
  # macOS: o ps já dá memória residente (KB) e CPU em % de um núcleo.
  while [ -f "$flag" ] && kill -0 "$pid" 2>/dev/null; do
    set -- $(ps -o rss=,%cpu= -p "$pid" | awk '{ printf "%.1f %.2f", $1 / 1024, $2 / 100 }')
    [ $# -eq 2 ] && emit "$(date +%s)" "$1" "$2"
    sleep 1
  done
fi
