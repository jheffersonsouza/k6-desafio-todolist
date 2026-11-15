import http from 'k6/http';
import { BASE_URL, authorization } from './config.js';

// Rotas da spec. A chave vira a tag "endpoint" (métricas por rota) e o valor vira a tag "name",
// que junta /todos/1, /todos/2... numa série só.
export const ROUTES = {
  list: 'GET /todos',
  create: 'POST /todos',
  update: 'PUT /todos/{id}',
  delete: 'DELETE /todos/{id}',
  login: 'POST /login',
  register: 'POST /register',
};

// Cada função só monta a requisição: send() envia uma, sendAll() envia várias em paralelo.
export const req = {
  register: (user) => build('register', '/register', { body: user }),
  login: ({ email, password }) => build('login', '/login', { body: { email, password } }),
  list: (token, page, limit) => build('list', `/todos?page=${page}&limit=${limit}`, { token }),
  create: (token, todo) => build('create', '/todos', { token, body: todo }),
  update: (token, id, todo) => build('update', `/todos/${id}`, { token, body: todo }),
  remove: (token, id) => build('delete', `/todos/${id}`, { token }),
};

export const send = (r) => http.request(r.method, r.url, r.body, r.params);
export const sendAll = (requests) => http.batch(requests);

// Marca a requisição como preparação do teste, para ela não entrar nas métricas por rota.
export const asSetup = (r) => ({ ...r, params: { ...r.params, tags: { ...r.params.tags, endpoint: 'setup' } } });

// Lê o corpo JSON sem lançar exceção quando ele não é JSON (ex.: 401 com corpo vazio).
export function json(res, path) {
  try {
    return path ? res.json(path) : res.json();
  } catch {
    return undefined;
  }
}

function build(endpoint, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token != null) headers.Authorization = authorization(token);
  return {
    method: ROUTES[endpoint].split(' ')[0],
    url: BASE_URL + path,
    body: body === undefined ? null : JSON.stringify(body),
    params: { headers, tags: { endpoint, name: ROUTES[endpoint] } },
  };
}
