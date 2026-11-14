// Perfis de carga, nos moldes dos tipos de teste do k6:
// https://grafana.com/docs/k6/latest/testing-guides/test-types/
// "target" multiplica RATE. O estágio com hold = true é o patamar principal; DURATION troca a duração dele.
export const PROFILES = {
  smoke: { stages: null },
  load: { stages: [stage('1m', 1), stage('5m', 1, true), stage('30s', 0)] },
  stress: { stages: [stage('2m', 2), stage('5m', 2, true), stage('1m', 0)] },
  spike: {
    stages: [stage('30s', 0.5), stage('10s', 5), stage('1m', 5, true), stage('10s', 0.5), stage('1m', 0.5), stage('10s', 0)],
  },
  soak: { stages: [stage('2m', 1), stage('30m', 1, true), stage('1m', 0)] },
  breakpoint: { stages: [stage('10m', 20, true)], abortOnFail: true },
};

// Mix de tráfego: fatia de RATE de cada cenário e as rotas que cada iteração chama.
export const MIX = {
  browse: { weight: 0.6, endpoints: ['list'], smokeIterations: 5 },
  write: { weight: 0.3, endpoints: ['create', 'update', 'delete'], smokeIterations: 5 },
  auth: { weight: 0.08, endpoints: ['login'], smokeIterations: 3 },
  signup: { weight: 0.02, endpoints: ['register'], smokeIterations: 3 },
};

const MAX_VUS_PER_SCENARIO = 500;

export function buildScenarios(profileName, { rate, duration, selected }) {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`PROFILE "${profileName}" não existe. Opções: ${Object.keys(PROFILES).join(', ')}`);
  }
  if (!selected.length || selected.some((name) => !MIX[name])) {
    throw new Error(`SCENARIOS "${selected.join(',')}" inválido. Opções: ${Object.keys(MIX).join(', ')}`);
  }

  const totalWeight = selected.reduce((sum, name) => sum + MIX[name].weight, 0);
  const scenarios = {};
  for (const name of selected) {
    if (!profile.stages) {
      scenarios[name] = {
        executor: 'per-vu-iterations',
        exec: name,
        vus: 1,
        iterations: MIX[name].smokeIterations,
        maxDuration: '2m',
      };
      continue;
    }

    // Modelo aberto: o k6 inicia iterações nessa taxa mesmo que a API esteja lenta, então as duas
    // APIs recebem a mesma carga. Taxa por minuto para aceitar frações (0,5 cadastro/s = 30/min).
    const perMinute = (rate * 60 * MIX[name].weight) / totalWeight;
    const stages = profile.stages.map((s) => ({
      duration: s.hold && duration ? duration : s.duration,
      target: Math.round(s.target * perMinute),
    }));
    const peakPerSecond = Math.max(...stages.map((s) => s.target)) / 60;
    const preAllocatedVUs = Math.min(Math.ceil(peakPerSecond * 0.2) + 2, MAX_VUS_PER_SCENARIO);
    scenarios[name] = {
      executor: 'ramping-arrival-rate',
      exec: name,
      startRate: 0,
      timeUnit: '1m',
      stages,
      preAllocatedVUs,
      // Quando a API demora e não sobra VU, o k6 descarta iterações e conta em dropped_iterations.
      maxVUs: Math.max(preAllocatedVUs, Math.min(Math.ceil(peakPerSecond * 2) + 10, MAX_VUS_PER_SCENARIO)),
    };
  }
  return scenarios;
}

// Carga que o k6 tentava gerar t segundos após o início (diz onde o breakpoint parou).
export function offeredLoadAt(scenarios, t) {
  let iterations = 0;
  let requests = 0;
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (!scenario.stages) continue;
    const perSecond = targetAt(scenario, t) / 60;
    iterations += perSecond;
    requests += perSecond * MIX[name].endpoints.length;
  }
  return { iterations, requests };
}

export function plannedSeconds(scenarios) {
  const first = Object.values(scenarios)[0];
  return first && first.stages ? first.stages.reduce((sum, s) => sum + seconds(s.duration), 0) : 0;
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

function seconds(duration) {
  const units = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, value, unit] of duration.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(value) * units[unit];
  return total;
}

function stage(duration, target, hold = false) {
  return { duration, target, hold };
}
