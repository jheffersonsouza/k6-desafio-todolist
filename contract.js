// Teste de contrato: confere se a API segue a spec do roadmap.sh antes de medir desempenho.
//   k6 run -e BASE_URL=http://localhost:8080 contract.js
// [MUST]   exigido pela spec. Uma falha reprova o teste (exit code 99).
// [SHOULD] boa prática que a spec não define. Aparece no resumo, mas não reprova.
import http from 'k6/http';
import { check, fail, group } from 'k6';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { BASE_URL } from './lib/config.js';
import { json, req, send } from './lib/client.js';
import { newTodo, newUser } from './lib/data.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    'checks{level:must}': ['rate==1'],
    'checks{level:should}': ['rate>=0'], // só para aparecer no resumo
    http_req_failed: ['rate==0'], // nenhum 5xx, em nenhum caso
  },
};

// Aqui 4xx faz parte do teste; só 5xx e erro de rede contam como falha.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export default function () {
  const probe = send(req.list(null, 1, 10));
  if (probe.status === 0) exec.test.abort(`A API não respondeu em ${BASE_URL} (${probe.error}). Ela está de pé?`);

  let alice;
  let bob;
  let todo;

  group('POST /register', () => {
    alice = newUser('alice');
    const res = send(req.register(alice));
    const ok = must(res, {
      'cadastro válido → 200/201': status(200, 201),
      'cadastro devolve { token }': hasToken,
    });
    if (!ok) fail(`cadastro falhou (${res.status} ${res.body}); sem usuário não dá para seguir`);

    const duplicate = send(req.register({ ...alice, name: 'Outro Nome' }));
    must(duplicate, { 'e-mail repetido → 4xx': clientError });
    should(duplicate, { 'e-mail repetido → 409 Conflict': status(409) });

    const { name, email, password } = newUser('invalido');
    must(send(req.register({ name, password })), { 'cadastro sem email → 4xx': clientError });
    must(send(req.register({ name, email })), { 'cadastro sem password → 4xx': clientError });
    should(send(req.register({ email, password })), { 'cadastro sem name → 4xx': clientError });
    should(send(req.register({ name, email: 'nao-e-um-email', password })), { 'cadastro com e-mail inválido → 4xx': clientError });
  });

  group('POST /login', () => {
    const res = send(req.login(alice));
    const ok = must(res, {
      'login válido → 200': status(200),
      'login devolve { token }': hasToken,
    });
    if (!ok) fail(`login falhou (${res.status} ${res.body}); sem token não dá para seguir`);
    alice.token = json(res, 'token');

    const wrong = send(req.login({ email: alice.email, password: `${alice.password}-errada` }));
    must(wrong, { 'senha errada → 4xx sem token': (r) => clientError(r) && !json(r, 'token') });
    should(wrong, { 'senha errada → 401': status(401) });
    must(send(req.login(newUser('ninguem'))), { 'e-mail não cadastrado → 4xx': clientError });
  });

  group('Sem token ou token inválido → 401', () => {
    const b64 = (value) => encoding.b64encode(JSON.stringify(value), 'rawurl');
    const claims = { sub: alice.email, email: alice.email, exp: 4102444800 };
    const forged = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.${'A'.repeat(43)}`;
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;

    const anonymous = send(req.list(null, 1, 10));
    must(anonymous, { 'GET /todos sem token → 401': status(401) });
    should(anonymous, { '401 devolve { "message": "Unauthorized" }': message('Unauthorized') });

    const cases = {
      'GET /todos com token qualquer → 401': req.list('token-invalido', 1, 10),
      'GET /todos com JWT de assinatura falsa → 401': req.list(forged, 1, 10),
      'GET /todos com JWT alg "none" → 401': req.list(unsigned, 1, 10),
      'POST /todos sem token → 401': req.create(null, newTodo()),
      'PUT /todos/{id} sem token → 401': req.update(null, 1, newTodo()),
      'DELETE /todos/{id} sem token → 401': req.remove(null, 1),
    };
    for (const [name, request] of Object.entries(cases)) must(send(request), { [name]: status(401) });
  });

  group('POST /todos', () => {
    const body = newTodo();
    const res = send(req.create(alice.token, body));
    const ok = must(res, {
      'criar → 200/201': status(200, 201),
      'criar devolve { id, title, description }': (r) =>
        json(r, 'id') != null && json(r, 'title') === body.title && json(r, 'description') === body.description,
    });
    should(res, { 'criar → 201 Created': status(201) });
    if (!ok) fail(`criar todo falhou (${res.status} ${res.body}); o resto depende dele`);
    todo = { ...body, id: json(res, 'id') };

    must(send(req.create(alice.token, { description: 'sem título' })), { 'criar sem title → 4xx': clientError });
  });

  group('PUT /todos/{id}', () => {
    bob = registered('bob');
    const forbidden = send(req.update(bob.token, todo.id, newTodo()));
    must(forbidden, { 'editar todo de outro usuário → 403': status(403) });
    should(forbidden, { '403 devolve { "message": "Forbidden" }': message('Forbidden') });
    should(findTodo(alice.token, todo.id), { 'todo continua igual depois do 403': (t) => !!t && t.title === todo.title });

    const changes = newTodo();
    must(send(req.update(alice.token, todo.id, changes)), {
      'dono edita → 200': status(200),
      'edição devolve o item atualizado': (r) =>
        json(r, 'id') == todo.id && json(r, 'title') === changes.title && json(r, 'description') === changes.description,
    });
    should(send(req.update(alice.token, todo.id, { description: 'sem título' })), { 'editar sem title → 4xx': clientError });
    should(send(req.update(alice.token, missingId(todo.id), newTodo())), { 'editar id inexistente → 404': status(404) });
  });

  group('DELETE /todos/{id}', () => {
    const forbidden = send(req.remove(bob.token, todo.id));
    must(forbidden, { 'apagar todo de outro usuário → 4xx': clientError });
    should(forbidden, { 'apagar todo de outro usuário → 403': status(403) });

    // 204 aqui também prova que a tentativa do bob não apagou o todo.
    must(send(req.remove(alice.token, todo.id)), { 'dono apaga → 204': status(204) });
    must(findTodo(alice.token, todo.id), { 'todo apagado sai da lista': (t) => t === null });
    should(send(req.remove(alice.token, todo.id)), { 'apagar de novo → 404': status(404) });
  });

  group('GET /todos (paginação)', () => {
    // Outro usuário com todo, para a lista da carol mostrar se vaza item alheio.
    send(req.create(bob.token, newTodo()));
    const carol = registered('carol');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(json(send(req.create(carol.token, newTodo())), 'id'));

    const page1 = send(req.list(carol.token, 1, 2));
    const items1 = json(page1, 'data') || [];
    must(page1, {
      'listar → 200': status(200),
      'listar devolve { data, page, limit, total }': (r) =>
        Array.isArray(json(r, 'data')) && ['page', 'limit', 'total'].every((key) => typeof json(r, key) === 'number'),
      'page=1&limit=2 → page 1 e limit 2': (r) => json(r, 'page') === 1 && json(r, 'limit') === 2,
      'page=1&limit=2 → 2 itens': () => items1.length === 2,
      'itens têm id, title e description': () =>
        items1.length > 0 && items1.every((t) => t.id != null && typeof t.title === 'string' && 'description' in t),
      'total conta pelo menos os 3 criados': (r) => json(r, 'total') >= 3,
    });
    should(page1, {
      'lista só traz os todos do próprio usuário': () => items1.every((t) => ids.some((id) => id == t.id)),
      'total conta só os todos do usuário': (r) => json(r, 'total') === 3,
    });

    const page2 = send(req.list(carol.token, 2, 2));
    const items2 = json(page2, 'data') || [];
    must(page2, {
      'page=2&limit=2 → 200 com itens': (r) => r.status === 200 && items2.length > 0,
      'page 2 não repete itens da page 1': () => items2.every((t) => !items1.some((u) => u.id == t.id)),
    });
    should(page2, { 'page=2&limit=2 → só o 3º item': () => items2.length === 1 });
    should(send(req.list(carol.token, 1000, 10)), {
      'página depois da última → 200 com data vazio': (r) => r.status === 200 && (json(r, 'data') || []).length === 0,
    });
  });
}

function must(value, checks) {
  return check(value, prefixed('MUST', checks), { level: 'must' });
}

function should(value, checks) {
  return check(value, prefixed('SHOULD', checks), { level: 'should' });
}

function prefixed(level, checks) {
  const result = {};
  for (const [name, fn] of Object.entries(checks)) result[`[${level}] ${name}`] = fn;
  return result;
}

function status(...codes) {
  return (r) => codes.includes(r.status);
}

function clientError(r) {
  return r.status >= 400 && r.status < 500;
}

function hasToken(r) {
  const token = json(r, 'token');
  return typeof token === 'string' && token.length > 0;
}

function message(text) {
  return (r) => json(r, 'message') === text;
}

function registered(prefix) {
  const user = newUser(prefix);
  const res = send(req.register(user));
  if (!hasToken(res)) fail(`não consegui cadastrar ${user.email}: ${res.status} ${res.body}`);
  return { ...user, token: json(res, 'token') };
}

// Procura o todo na lista do dono. null = não está lá; undefined = a listagem falhou.
function findTodo(token, id) {
  for (let page = 1; page <= 5; page++) {
    const res = send(req.list(token, page, 50));
    const items = res.status === 200 ? json(res, 'data') : undefined;
    if (!Array.isArray(items)) return undefined;
    const found = items.find((t) => t.id == id);
    if (found) return found;
    if (items.length < 50) return null;
  }
  return null;
}

// Um id que não existe, no mesmo formato do id real (número ou UUID).
function missingId(id) {
  return typeof id === 'number' ? 2147483647 : '00000000-0000-0000-0000-000000000000';
}
