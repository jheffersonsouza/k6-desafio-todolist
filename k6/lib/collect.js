import { API, BASE_URL, CHECKLIST, DURATION, PROFILE, RATE, ROTAS } from './config.js';
import { ROUTES } from './client.js';
import { offeredAt } from './profiles.js';

// Junta o resumo do k6 num objeto simples, salvo em results/<nome>.json e usado pelos relatórios.
// As métricas por rota e por fatia de tempo só existem porque o load.js define thresholds para elas.
export function collect(summary, testPlan, scenarios) {
  const metrics = summary.metrics;
  const startedAt = summary.setup_data && summary.setup_data.startedAt;
  if (!startedAt) return null;
  const finishedAt = Date.now();
  const elapsed = (finishedAt - startedAt) / 1000;

  const endpoints = {};
  for (const key of Object.keys(ROUTES)) {
    const stats = trend(metrics[`http_req_duration{endpoint:${key}}`]);
    if (stats) endpoints[key] = { ...stats, errorRate: rate(metrics[`http_req_failed{endpoint:${key}}`]) };
  }
  if (!Object.keys(endpoints).length) return null;

  const buckets = [];
  for (let index = 0; index < testPlan.buckets; index++) {
    const start = index * testPlan.bucketSeconds;
    // No teste de capacidade, cada degrau é medido só depois da rampa, já na carga cheia.
    const from = start + testPlan.rampSeconds;
    const length = Math.min(start + testPlan.bucketSeconds, elapsed) - from;
    if (length <= 0) break;
    const stats = trend(metrics[`http_req_duration{bucket:${index}}`]) || { count: 0 };
    const bucket = {
      index,
      start,
      length,
      // No teste de capacidade, a carga do degrau já no patamar; nos outros, a carga no meio da fatia.
      targetRps: offeredAt(scenarios, testPlan.steps ? from + 0.5 : from + length / 2),
      // Média do que o k6 tentou gerar na fatia, para comparar com o que a API atendeu.
      offeredRps: average(10, (i) => offeredAt(scenarios, from + ((i + 0.5) * length) / 10)),
      rps: stats.count / length,
      ...stats,
      errorRate: stats.count ? rate(metrics[`http_req_failed{bucket:${index}}`]) : 0,
    };
    if (testPlan.steps) {
      bucket.endpoints = {};
      for (const key of Object.keys(endpoints)) {
        const perRoute = trend(metrics[`http_req_duration{bucket:${index},endpoint:${key}}`]);
        if (perRoute) bucket.endpoints[key] = { p95: perRoute.p95, count: perRoute.count };
      }
    }
    buckets.push(bucket);
  }

  const routes = Object.values(endpoints);
  const requests = routes.reduce((sum, e) => sum + e.count, 0);
  const errors = routes.reduce((sum, e) => sum + e.count * e.errorRate, 0);
  return {
    version: 1,
    api: API,
    test: PROFILE,
    title: testPlan.profile.title,
    rate: RATE,
    duration: DURATION || null,
    rotas: ROTAS,
    baseUrl: BASE_URL,
    checklist: CHECKLIST || null,
    startedAt,
    finishedAt,
    elapsed,
    plannedSeconds: testPlan.totalSeconds,
    stoppedEarly: elapsed < testPlan.totalSeconds - 5,
    steps: Boolean(testPlan.steps),
    bucketSeconds: testPlan.bucketSeconds,
    totals: {
      requests,
      rps: requests / elapsed,
      errorRate: requests ? errors / requests : 0,
      overall: trend(metrics['http_req_duration{fase:teste}']),
    },
    endpoints,
    buckets,
    resources: null,
  };
}

function trend(metric) {
  if (!metric || !metric.values.count) return null;
  const v = metric.values;
  return { count: v.count, p50: v.med, p95: v['p(95)'], p99: v['p(99)'], max: v.max };
}

function rate(metric) {
  return metric ? metric.values.rate : 0;
}

function average(n, fn) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += fn(i);
  return sum / n;
}
