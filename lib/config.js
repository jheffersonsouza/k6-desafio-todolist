// Configuração lida das variáveis de ambiente: k6 run -e NOME=valor <script>.
// O README descreve cada variável.

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
export const API = __ENV.API || 'api';
export const PROFILE = __ENV.PROFILE || 'smoke';
export const RATE = positive('RATE', 100);
export const USERS = positive('USERS', PROFILE === 'smoke' ? 5 : 50);
export const DURATION = __ENV.DURATION || '';
export const SCENARIOS = (__ENV.SCENARIOS || 'browse,write,auth,signup')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// A spec manda o token puro ("Authorization: <token>"), mas Spring Security e ASP.NET
// esperam "Authorization: Bearer <token>" por padrão. AUTH_SCHEME=none manda o token puro.
const AUTH_SCHEME = __ENV.AUTH_SCHEME || 'Bearer';

export function authorization(token) {
  return AUTH_SCHEME.toLowerCase() === 'none' ? token : `${AUTH_SCHEME} ${token}`;
}

function positive(name, fallback) {
  if (!__ENV[name]) return fallback;
  const value = Number(__ENV[name]);
  if (!(value > 0)) throw new Error(`${name} precisa ser um número maior que zero, veio "${__ENV[name]}"`);
  return value;
}
