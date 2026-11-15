// Tipos de teste. Nos estágios, "target" multiplica RATE (iterações por segundo, somando os grupos de rotas).
export const PROFILES = {
  dev: {
    title: 'teste rápido',
    stages: [stage('15s', 1), stage('1m', 1, true), stage('5s', 0)],
    bucketSeconds: 10,
  },
  capacidade: {
    title: 'teste de capacidade',
    // Degraus de carga, cada um o dobro do anterior. Cada degrau vira uma fatia do relatório.
    steps: [0.25, 0.5, 1, 2, 4, 8, 16, 32],
    stepSeconds: 30,
    rampSeconds: 5,
  },
  resistencia: {
    title: 'teste de resistência',
    stages: [stage('1m', 1), stage('30m', 1, true), stage('30s', 0)],
    bucketSeconds: 60,
  },
};

// Grupos de rotas: fatia de RATE de cada um e as rotas que cada iteração chama.
export const MIX = {
  listar: { weight: 0.6, endpoints: ['list'] },
  gravar: { weight: 0.3, endpoints: ['create', 'update', 'delete'] },
  login: { weight: 0.08, endpoints: ['login'] },
  cadastro: { weight: 0.02, endpoints: ['register'] },
};

const MAX_VUS_PER_GROUP = 500;

// Estágios, tamanho das fatias e duração total do teste. DURATION troca o patamar principal
// (no teste de capacidade, a duração de cada degrau).
export function plan(profileName, duration) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Teste "${profileName}" não existe. Opções: ${Object.keys(PROFILES).join(', ')}`);

  if (profile.steps) {
    const stepSeconds = duration ? seconds(duration) : profile.stepSeconds;
    const ramp = Math.min(profile.rampSeconds, stepSeconds / 2);
    const stages = profile.steps.flatMap((target) => [
      { duration: `${ramp}s`, target },
      { duration: `${stepSeconds - ramp}s`, target },
    ]);
    return { profile, stages, steps: profile.steps, rampSeconds: ramp, bucketSeconds: stepSeconds, ...totals(stages, stepSeconds) };
  }

  const stages = profile.stages.map((s) => ({ duration: s.hold && duration ? duration : s.duration, target: s.target }));
  return { profile, stages, steps: null, rampSeconds: 0, bucketSeconds: profile.bucketSeconds, ...totals(stages, profile.bucketSeconds) };
}

export function buildScenarios(testPlan, rate, selected) {
  if (!selected.length || selected.some((name) => !MIX[name])) {
    throw new Error(`ROTAS "${selected.join(',')}" inválido. Opções: ${Object.keys(MIX).join(', ')}`);
  }
  const totalWeight = selected.reduce((sum, name) => sum + MIX[name].weight, 0);
  const scenarios = {};
  for (const name of selected) {
    // Modelo aberto: o k6 inicia iterações nessa taxa mesmo que a API esteja lenta, então as duas APIs
    // recebem a mesma carga. Taxa por minuto para aceitar frações (0,5 cadastro/s = 30/min).
    const perMinute = (rate * 60 * MIX[name].weight) / totalWeight;
    const stages = testPlan.stages.map((s) => ({ duration: s.duration, target: Math.round(s.target * perMinute) }));
    const peakPerSecond = Math.max(...stages.map((s) => s.target)) / 60;
    const preAllocatedVUs = Math.min(Math.ceil(peakPerSecond * 0.02) + 2, MAX_VUS_PER_GROUP);
    scenarios[name] = {
      executor: 'ramping-arrival-rate',
      exec: name,
      startRate: 0,
      timeUnit: '1m',
      stages,
      preAllocatedVUs,
      // Quando a API demora e não sobra VU, o k6 deixa de iniciar iterações: aparece como carga não atendida.
      maxVUs: Math.max(preAllocatedVUs, Math.min(Math.ceil(peakPerSecond * 0.5) + 10, MAX_VUS_PER_GROUP)),
    };
  }
  return scenarios;
}

// Requisições por segundo que o k6 tenta gerar t segundos depois do início.
export function offeredAt(scenarios, t) {
  let requests = 0;
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (scenario.stages && MIX[name]) requests += (targetAt(scenario, t) / 60) * MIX[name].endpoints.length;
  }
  return requests;
}

export function seconds(duration) {
  const units = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, value, unit] of String(duration).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(value) * units[unit];
  if (!total) throw new Error(`DURATION "${duration}" inválido. Exemplos: 30s, 2m, 1h`);
  return total;
}

function totals(stages, bucketSeconds) {
  const totalSeconds = stages.reduce((sum, s) => sum + seconds(s.duration), 0);
  return { totalSeconds, buckets: Math.ceil(totalSeconds / bucketSeconds) };
}

function targetAt(scenario, t) {
  let start = 0;
  let from = scenario.startRate;
  for (const s of scenario.stages) {
    const length = seconds(s.duration);
    if (t < start + length) return from + ((s.target - from) * (t - start)) / length;
    start += length;
    from = s.target;
  }
  return 0;
}

function stage(duration, target, hold = false) {
  return { duration, target, hold };
}
