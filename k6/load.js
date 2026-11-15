// Teste de carga. Use pelo run.sh ou run.bat (comandos dev, capacidade e resistencia); o README explica cada um.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { API, BASE_URL, DURATION, PROFILE, RATE, ROTAS, RUN_LABEL, RUN_NAME, USERS } from './lib/config.js';
import { asSetup, json, req, send, sendAll } from './lib/client.js';
import { collect } from './lib/collect.js';
import { newTodo, newUser } from './lib/data.js';
import { MIX, buildScenarios, offeredAt, plan } from './lib/profiles.js';
import { clock, int, renderHtml, renderText } from './lib/render.js';

const SEED_TODOS = 25; // por usuário: 3 páginas de 10
const PAGE_SIZE = 10;

const PLAN = plan(PROFILE, DURATION);
const scenarios = buildScenarios(PLAN, RATE, ROTAS);

export const options = {
  scenarios: {
    ...scenarios,
    // Só escreve o andamento no terminal; não faz requisição.
    progresso: { executor: 'constant-vus', exec: 'progresso', vus: 1, duration: `${PLAN.totalSeconds}s`, gracefulStop: '0s' },
  },
  thresholds: thresholds(),
  setupTimeout: '10m',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max', 'count'],
  // Separam as execuções no painel: rotulo é o nome legível ("ts · rápido · 15/11 22:19").
  // Rodando o k6 direto, sem run.sh/run.bat, tudo vira "local".
  tags: { api: API, run: RUN_NAME || 'local', rotulo: RUN_LABEL || RUN_NAME || 'local' },
  // Só as tags de sistema que o painel e o relatório usam: menos dado para o InfluxDB guardar.
  systemTags: ['status', 'method', 'name', 'scenario', 'check', 'error_code', 'expected_response'],
};

export function setup() {
  const probe = send(asSetup(req.list(null, 1, 1)));
  if (probe.status === 0) exec.test.abort(`A API não respondeu em ${BASE_URL} (${probe.error}). Ela está de pé?`);

  const users = Array.from({ length: USERS }, () => newUser('load'));
  sendAll(users.map((user) => asSetup(req.register(user)))).forEach((res, i) => {
    users[i].token = json(res, 'token');
    if (!users[i].token) exec.test.abort(`O cadastro precisa devolver 200/201 com { token }, veio: ${res.status} ${short(res.body)}`);
  });

  // Cada usuário começa com SEED_TODOS tarefas, para a listagem paginar de verdade.
  const seed = users.flatMap((user) => Array.from({ length: SEED_TODOS }, () => asSetup(req.create(user.token, newTodo()))));
  for (let i = 0; i < seed.length; i += 100) {
    for (const res of sendAll(seed.slice(i, i + 100))) {
      if (!created(res)) exec.test.abort(`POST /todos precisa devolver 200/201, veio: ${res.status} ${short(res.body)}`);
    }
  }
  console.log(`  Começando: ${PLAN.profile.title}, ${clock(PLAN.totalSeconds)} no máximo.`);
  return { users, startedAt: Date.now() };
}

// Grupo listar: uma página qualquer das tarefas do usuário.
export function listar(data) {
  mark(data);
  const page = 1 + Math.floor(Math.random() * Math.ceil(SEED_TODOS / PAGE_SIZE));
  check(send(req.list(pick(data.users).token, page, PAGE_SIZE)), {
    'listar: 200 com data[]': (r) => r.status === 200 && Array.isArray(json(r, 'data')),
  });
}

// Grupo gravar: cria, edita e apaga a mesma tarefa, então o volume de dados fica estável.
export function gravar(data) {
  mark(data);
  const { token } = pick(data.users);
  const res = send(req.create(token, newTodo()));
  const id = json(res, 'id');
  if (!check(res, { 'criar: 200/201 com id': (r) => created(r) && id != null })) return;
  check(send(req.update(token, id, newTodo())), { 'editar: 200': (r) => r.status === 200 });
  check(send(req.remove(token, id)), { 'apagar: 204': (r) => r.status === 204 });
}

// Grupo login: login de um usuário já cadastrado.
export function login(data) {
  mark(data);
  check(send(req.login(pick(data.users))), { 'login: 200 com token': (r) => r.status === 200 && !!json(r, 'token') });
}

// Grupo cadastro: cadastro de um usuário novo.
export function cadastro(data) {
  mark(data);
  check(send(req.register(newUser('signup'))), { 'cadastro: 200/201 com token': (r) => created(r) && !!json(r, 'token') });
}

let progressCalls = 0;

// Uma linha por degrau no teste de capacidade; nos outros, a cada 10 s (ou 1 min nos testes longos).
export function progresso(data) {
  if (PLAN.steps) sleep(progressCalls++ === 0 ? PLAN.rampSeconds + 1 : PLAN.bucketSeconds);
  else sleep(PLAN.totalSeconds > 300 ? 60 : 10);
  const t = (Date.now() - data.startedAt) / 1000;
  const where = PLAN.steps
    ? `degrau ${Math.min(PLAN.buckets, Math.floor(t / PLAN.bucketSeconds) + 1)} de ${PLAN.buckets}`
    : `${clock(t)} de ${clock(PLAN.totalSeconds)}`;
  console.log(`  ⏱ ${where} · carga de ~${int(offeredAt(scenarios, t))} req/s`);
}

export function handleSummary(summary) {
  const run = collect(summary, PLAN, scenarios);
  if (!run) return { stdout: '\n  O teste de carga não começou. O motivo aparece logo abaixo.\n\n' };
  const name = RUN_NAME || `${API}_${PROFILE}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const files = { [`results/${name}.json`]: JSON.stringify(run, null, 2) };
  // Pelo run.sh/run.bat, o relatório sai no passo seguinte, já com memória e CPU.
  if (RUN_NAME) return { ...files, stdout: '\n  Teste terminado. Montando o relatório...\n' };
  return {
    ...files,
    [`results/${name}.html`]: renderHtml(run),
    stdout: renderText(run, { color: summary.state.isStdOutTTY, file: `results/${name}.html` }),
  };
}

function thresholds() {
  // Os thresholds aqui só fazem o k6 guardar as métricas por rota e por fatia de tempo (sempre passam).
  // Quem diz se a API foi bem é o relatório. A exceção é o degrau quebrado do teste de capacidade.
  const result = { 'http_req_duration{fase:teste}': ['max>=0'] };
  const endpoints = ROTAS.flatMap((name) => MIX[name].endpoints);
  for (const endpoint of endpoints) {
    result[`http_req_duration{endpoint:${endpoint}}`] = ['max>=0'];
    result[`http_req_failed{endpoint:${endpoint}}`] = ['rate>=0'];
  }
  for (let bucket = 0; bucket < PLAN.buckets; bucket++) {
    if (PLAN.steps) {
      // Degrau claramente quebrado (muito erro ou lento demais): para o teste, não adianta subir mais.
      const stop = (threshold) => [{ threshold, abortOnFail: true, delayAbortEval: '10s' }];
      result[`http_req_failed{bucket:${bucket}}`] = stop('rate<0.2');
      result[`http_req_duration{bucket:${bucket}}`] = stop('p(95)<3000');
      for (const endpoint of endpoints) result[`http_req_duration{bucket:${bucket},endpoint:${endpoint}}`] = ['max>=0'];
    } else {
      result[`http_req_failed{bucket:${bucket}}`] = ['rate>=0'];
      result[`http_req_duration{bucket:${bucket}}`] = ['max>=0'];
    }
  }
  return result;
}

// Marca as métricas da iteração com a fatia de tempo, para os gráficos do relatório.
// No teste de capacidade, as iterações da rampa entre um degrau e outro ficam de fora.
function mark(data) {
  const tags = exec.vu.metrics.tags;
  const t = (Date.now() - data.startedAt) / 1000;
  tags.fase = 'teste';
  if (PLAN.steps && t % PLAN.bucketSeconds < PLAN.rampSeconds) {
    delete tags.bucket;
    return;
  }
  tags.bucket = Math.max(0, Math.min(PLAN.buckets - 1, Math.floor(t / PLAN.bucketSeconds)));
}

function pick(users) {
  return users[Math.floor(Math.random() * users.length)];
}

function created(res) {
  return res.status === 200 || res.status === 201;
}

function short(body) {
  return String(body).slice(0, 200);
}
