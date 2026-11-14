import { API, BASE_URL, PROFILE, RATE, SCENARIOS } from './config.js';
import { ROUTES } from './client.js';
import { offeredLoadAt, plannedSeconds } from './profiles.js';

// Relatório de uma execução do load.js: tabela no terminal, mais JSON e Markdown em results/.
// As métricas por rota só existem porque o load.js define thresholds para cada uma.
export function loadReport(data, scenarios) {
  const finished = new Date();
  const startedAt = data.setup_data && data.setup_data.startedAt;
  // Conta a partir do fim do setup, para o cadastro dos usuários de teste não diluir o req/s.
  const elapsed = startedAt ? (finished.getTime() - startedAt) / 1000 : data.state.testRunDurationMs / 1000;

  const endpoints = {};
  for (const [key, route] of Object.entries(ROUTES)) {
    const duration = data.metrics[`http_req_duration{endpoint:${key}}`];
    if (!duration || !duration.values.count) continue;
    const failed = data.metrics[`http_req_failed{endpoint:${key}}`];
    const v = duration.values;
    endpoints[key] = {
      route,
      count: v.count,
      rps: round(v.count / elapsed),
      avg: round(v.avg),
      p50: round(v.med),
      p90: round(v['p(90)']),
      p95: round(v['p(95)']),
      p99: round(v['p(99)']),
      max: round(v.max),
      errorRate: failed ? failed.values.rate : 0,
    };
  }

  const rows = Object.values(endpoints);
  if (!rows.length) return { stdout: '\nNenhuma requisição medida (o setup falhou?). Nada foi salvo em results/.\n' };
  const requests = rows.reduce((sum, e) => sum + e.count, 0);
  const errors = rows.reduce((sum, e) => sum + e.count * e.errorRate, 0);
  const thresholds = [];
  for (const [metric, m] of Object.entries(data.metrics)) {
    for (const [threshold, t] of Object.entries(m.thresholds || {})) thresholds.push({ metric, threshold, ok: t.ok });
  }

  const report = {
    api: API,
    profile: PROFILE,
    rate: RATE,
    scenarios: SCENARIOS,
    baseUrl: BASE_URL,
    finishedAt: finished.toISOString(),
    durationSec: round(elapsed),
    totals: {
      requests,
      rps: round(requests / elapsed),
      errorRate: requests ? errors / requests : 0,
      checksRate: metric(data, 'checks', 'rate'),
      droppedIterations: metric(data, 'dropped_iterations', 'count') || 0,
      vusMax: metric(data, 'vus_max', 'max'),
    },
    endpoints,
    breakpoint: PROFILE === 'breakpoint' && startedAt ? breakpointAt(scenarios, elapsed) : null,
    thresholds,
    passed: thresholds.every((t) => t.ok),
  };

  const markdown = loadMarkdown(report);
  // Com o dashboard ligado (run.sh), usa o mesmo nome do relatório HTML.
  const html = __ENV.K6_WEB_DASHBOARD_EXPORT || '';
  const file = html.endsWith('.html')
    ? html.slice(0, -'.html'.length)
    : `results/${API}_${PROFILE}_${finished.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  return {
    stdout: `\n${markdown}\nSalvo em ${file}.json e ${file}.md\n`,
    [`${file}.json`]: JSON.stringify(report, null, 2),
    [`${file}.md`]: markdown,
  };
}

// Tabela lado a lado de dois relatórios JSON gerados pelo load.js.
export function compareReport(a, b) {
  const lines = [`## A = ${a.api} (${a.finishedAt}) · B = ${b.api} (${b.finishedAt})`, ''];
  if (a.profile !== b.profile || a.rate !== b.rate || a.scenarios.join() !== b.scenarios.join()) {
    lines.push(
      `> ⚠ Parâmetros diferentes (perfil ${a.profile} x ${b.profile}, RATE ${a.rate} x ${b.rate}, ` +
        `cenários ${a.scenarios.join(',')} x ${b.scenarios.join(',')}): a comparação não é justa.`,
      '',
    );
  }

  const keys = Object.keys(ROUTES).filter((key) => a.endpoints[key] || b.endpoints[key]);
  const latency = (e) => (e ? `${ms(e.p50)} / ${ms(e.p95)} / ${ms(e.p99)}` : '-');
  lines.push(
    table(
      ['rota', 'A p50 / p95 / p99', 'B p50 / p95 / p99', 'Δ p95', 'erros A', 'erros B'],
      keys.map((key) => {
        const [ea, eb] = [a.endpoints[key], b.endpoints[key]];
        return [ROUTES[key], latency(ea), latency(eb), ea && eb ? diff(ea.p95, eb.p95) : '-', ea ? pct(ea.errorRate) : '-', eb ? pct(eb.errorRate) : '-'];
      }),
      'lrrrrr',
    ),
    '',
    'Δ p95 = B em relação a A (negativo = B mais rápido).',
    '',
  );

  const totals = [
    ['req/s', fixed(a.totals.rps), fixed(b.totals.rps)],
    ['erros', pct(a.totals.errorRate), pct(b.totals.errorRate)],
    ['checks', pct(a.totals.checksRate), pct(b.totals.checksRate)],
    ['iterações descartadas', a.totals.droppedIterations, b.totals.droppedIterations],
    ['VUs máx', a.totals.vusMax ?? '-', b.totals.vusMax ?? '-'],
    ['thresholds', a.passed ? 'ok' : 'falhou', b.passed ? 'ok' : 'falhou'],
  ];
  if (a.breakpoint || b.breakpoint) {
    const limit = (r) => (r.breakpoint ? `${r.breakpoint.requestsPerSec} req/s${r.breakpoint.stoppedEarly ? '' : ' (não quebrou)'}` : '-');
    totals.push(['ruptura', limit(a), limit(b)]);
  }
  lines.push(table(['', 'A', 'B'], totals, 'lrr'));
  return `\n${lines.join('\n')}\n`;
}

function loadMarkdown(r) {
  const t = r.totals;
  const lines = [
    `## ${r.api} · ${r.profile} · ${r.finishedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- ${r.baseUrl}, RATE ${r.rate} it/s, cenários ${r.scenarios.join(', ')}`,
    `- ${r.durationSec}s, ${t.requests} requisições (${fixed(t.rps)} req/s), erros ${pct(t.errorRate)}, checks ${pct(t.checksRate)}`,
    `- iterações descartadas: ${t.droppedIterations}, VUs máx: ${t.vusMax ?? '-'}`,
  ];
  if (r.breakpoint) {
    const b = r.breakpoint;
    lines.push(
      b.stoppedEarly
        ? `- **ruptura**: parou aos ${b.atSec}s, quando o k6 gerava ~${b.iterationsPerSec} it/s (~${b.requestsPerSec} req/s)`
        : `- não quebrou: chegou a ~${b.iterationsPerSec} it/s (~${b.requestsPerSec} req/s). Aumente RATE.`,
    );
  }
  lines.push(
    '',
    table(
      ['rota', 'reqs', 'req/s', 'p50', 'p90', 'p95', 'p99', 'máx', 'erros'],
      Object.values(r.endpoints).map((e) => [e.route, e.count, fixed(e.rps), ms(e.p50), ms(e.p90), ms(e.p95), ms(e.p99), ms(e.max), pct(e.errorRate)]),
      'lrrrrrrrr',
    ),
    '',
  );
  const failed = r.thresholds.filter((t) => !t.ok);
  lines.push(failed.length ? ['Thresholds estourados:', ...failed.map((f) => `- ✗ ${f.metric}: ${f.threshold}`)].join('\n') : 'Thresholds: todos ok ✓');
  return `${lines.join('\n')}\n`;
}

function breakpointAt(scenarios, elapsed) {
  const planned = plannedSeconds(scenarios);
  const at = Math.min(elapsed, planned);
  const load = offeredLoadAt(scenarios, at);
  return {
    stoppedEarly: elapsed < planned - 5,
    atSec: round(at, 0),
    iterationsPerSec: round(load.iterations, 0),
    requestsPerSec: round(load.requests, 0),
  };
}

// Tabela Markdown com colunas alinhadas, legível também no terminal. align: 'l' ou 'r' por coluna.
function table(headers, rows, align) {
  const cells = [headers, ...rows].map((row) => row.map(String));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((row) => row[i].length)));
  const line = (row) => `| ${row.map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' | ')} |`;
  const rule = `| ${widths.map((w, i) => (align[i] === 'r' ? `${'-'.repeat(w - 1)}:` : '-'.repeat(w))).join(' | ')} |`;
  return [line(cells[0]), rule, ...cells.slice(1).map(line)].join('\n');
}

function metric(data, name, field) {
  return data.metrics[name] ? data.metrics[name].values[field] : undefined;
}

const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const fixed = (n) => (n === undefined ? '-' : n.toFixed(1));
const pct = (rate) => (rate === undefined ? '-' : `${(rate * 100).toFixed(2)}%`);
const ms = (v) => (v === undefined ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(v < 10 ? 2 : 1)}ms`);
const diff = (a, b) => (a > 0 ? `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(1)}%` : '-');
