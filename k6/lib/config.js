// Configuração lida das variáveis de ambiente (o run.sh e o run.bat passam o que está no .env).
// O README descreve cada uma.

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
export const API = __ENV.API || 'api';
export const PROFILE = __ENV.PROFILE || 'dev';
export const RATE = positive('RATE', 100);
export const USERS = positive('USERS', 50);
export const DURATION = __ENV.DURATION || '';
export const ROTAS = (__ENV.ROTAS || 'listar,gravar,login,cadastro')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// Nome dos arquivos em results/ e rótulo legível da execução no painel, definidos pelo run.sh/run.bat.
// Vazios quando o k6 roda direto.
export const RUN_NAME = __ENV.RUN_NAME || '';
export const RUN_LABEL = __ENV.RUN_LABEL || '';

// Resultado do checklist rodado antes do teste de carga: "ok", "falhou" ou vazio.
export const CHECKLIST = __ENV.CHECKLIST || '';

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
