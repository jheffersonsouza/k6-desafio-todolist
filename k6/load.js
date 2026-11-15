// Teste de desempenho: k6 run -e BASE_URL=http://localhost:8080 -e API=java -e PROFILE=load load.js
// Perfis, cenários e variáveis no README.
import { check } from 'k6';
import exec from 'k6/execution';
import { API, BASE_URL, DURATION, PROFILE, RATE, SCENARIOS, USERS } from './lib/config.js';
import { asSetup, json, req, send, sendAll } from './lib/client.js';
import { newTodo, newUser } from './lib/data.js';
import { MIX, PROFILES, buildScenarios } from './lib/profiles.js';
import { loadReport } from './lib/report.js';

const SEED_TODOS = 25; // por usuário: 3 páginas de 10
const PAGE_SIZE = 10;

// p(95) máximo por rota, em ms. Login e cadastro calculam hash de senha, por isso o limite maior.
const SLO_P95_MS = { list: 300, create: 500, update: 500, delete: 500, login: 1000, register: 1000 };

const scenarios = buildScenarios(PROFILE, { rate: RATE, duration: DURATION, selected: SCENARIOS });

export const options = {
  scenarios,
  thresholds: thresholds(),
  setupTimeout: '10m',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  tags: { api: API },
};

export function setup() {
  const probe = send(asSetup(req.list(null, 1, 1)));
  if (probe.status === 0) exec.test.abort(`A API não respondeu em ${BASE_URL} (${probe.error}). Ela está de pé?`);
  if (probe.status !== 401) console.warn(`GET /todos sem token respondeu ${probe.status}, esperado 401. Rode o contract.js.`);

  const users = Array.from({ length: USERS }, () => newUser('load'));
  sendAll(users.map((user) => asSetup(req.register(user)))).forEach((res, i) => {
    users[i].token = json(res, 'token');
    if (!users[i].token) exec.test.abort(`Falha ao cadastrar usuário de teste: ${res.status} ${short(res.body)}`);
  });

  // Cada usuário começa com SEED_TODOS itens, para a listagem paginar de verdade.
  const seed = users.flatMap((user) => Array.from({ length: SEED_TODOS }, () => asSetup(req.create(user.token, newTodo()))));
  for (let i = 0; i < seed.length; i += 100) {
    for (const res of sendAll(seed.slice(i, i + 100))) {
      if (!created(res)) exec.test.abort(`Falha ao criar os todos iniciais: ${res.status} ${short(res.body)}`);
    }
  }
  return { users, startedAt: Date.now() };
}

// Cenário browse: lista uma página qualquer dos todos do usuário.
export function browse({ users }) {
  const page = 1 + Math.floor(Math.random() * Math.ceil(SEED_TODOS / PAGE_SIZE));
  check(send(req.list(pick(users).token, page, PAGE_SIZE)), {
    'list: 200 com data[]': (r) => r.status === 200 && Array.isArray(json(r, 'data')),
  });
}

// Cenário write: cria, edita e apaga o mesmo todo, então o volume de dados fica estável.
export function write({ users }) {
  const { token } = pick(users);
  const res = send(req.create(token, newTodo()));
  const id = json(res, 'id');
  if (!check(res, { 'create: 200/201 com id': (r) => created(r) && id != null })) return;
  check(send(req.update(token, id, newTodo())), { 'update: 200': (r) => r.status === 200 });
  check(send(req.remove(token, id)), { 'delete: 204': (r) => r.status === 204 });
}

// Cenário auth: login de um usuário já cadastrado.
export function auth({ users }) {
  check(send(req.login(pick(users))), { 'login: 200 com token': (r) => r.status === 200 && !!json(r, 'token') });
}

// Cenário signup: cadastro de um usuário novo.
export function signup() {
  check(send(req.register(newUser('signup'))), { 'register: 200/201 com token': (r) => created(r) && !!json(r, 'token') });
}

export function handleSummary(data) {
  return loadReport(data, scenarios);
}

function thresholds() {
  // No breakpoint o k6 para sozinho quando um limite estoura: esse é o ponto de ruptura.
  const abort = PROFILES[PROFILE].abortOnFail;
  const rule = (threshold) => (abort ? [{ threshold, abortOnFail: true, delayAbortEval: '30s' }] : [threshold]);
  const result = { http_req_failed: rule('rate<0.01'), checks: ['rate>0.99'] };
  for (const name of SCENARIOS) {
    for (const endpoint of MIX[name].endpoints) {
      result[`http_req_duration{endpoint:${endpoint}}`] = rule(`p(95)<${SLO_P95_MS[endpoint]}`);
      result[`http_req_failed{endpoint:${endpoint}}`] = rule('rate<0.01');
    }
  }
  return result;
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
