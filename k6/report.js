// Monta o relatório de uma execução: junta results/<nome>.json (do load.js) com a memória e a CPU medidas
// pelo run.sh/run.bat (results/<nome>.recursos.csv) e grava um resumo no painel (tabela Execuções).
// Uso: k6 run -e RUN_NAME=<nome> k6/report.js
import http from 'k6/http';
import { analyze, parseResources, renderHtml, renderText } from './lib/render.js';

const name = __ENV.RUN_NAME;
const data = load();

export const options = { vus: 1, iterations: 1 };

// Uma linha por execução na tabela Execuções do painel, com o intervalo de tempo para abrir só ela.
export default function () {
  if (!data) return;
  const capacity = analyze(data).capacity;
  const o = data.totals.overall || {};
  const r = data.resources;
  const fields = {
    teste: `"${data.test}"`,
    checklist: `"${data.checklist || 'não rodou'}"`,
    inicio: `${data.startedAt - 10000}i`,
    fim: `${data.finishedAt + 5000}i`,
    requisicoes: `${data.totals.requests}i`,
    normal_ms: o.p50,
    p95_ms: o.p95,
    erros_pct: data.totals.errorRate * 100,
    aguentou_rps: capacity && capacity.healthy ? capacity.healthy.rps : null,
    memoria_pico_mb: r ? r.peakMb : null,
    cpu_pico: r ? r.peakCores : null,
  };
  const values = Object.entries(fields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const label = __ENV.RUN_LABEL || name;
  const line = `execucoes,api=${tag(data.api)},run=${tag(name)},rotulo=${tag(label)} ${values} ${data.startedAt}`;
  http.post('http://influxdb:8086/write?db=k6&precision=ms', line, { timeout: '5s', responseType: 'none' });
}

export function handleSummary(summary) {
  if (!data) return { stdout: `\n  Não achei results/${name}.json: o teste parou antes de medir alguma coisa.\n\n` };
  const html = `results/${name}.html`;
  return {
    stdout: renderText(data, { color: summary.state.isStdOutTTY, file: html }),
    [html]: renderHtml(data),
    [`results/${name}.json`]: JSON.stringify(data, null, 2),
  };
}

function load() {
  const run = read(`../results/${name}.json`);
  if (!run) return null;
  const parsed = JSON.parse(run);
  const csv = read(`../results/${name}.recursos.csv`);
  if (csv) parsed.resources = parseResources(csv, parsed);
  return parsed;
}

function read(path) {
  try {
    return open(path);
  } catch {
    return null;
  }
}

// Valor de tag no formato do InfluxDB: espaço, vírgula e sinal de igual escapados.
function tag(value) {
  return String(value).replace(/[ ,=]/g, '\\$&');
}
