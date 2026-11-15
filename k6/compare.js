// Compara duas execuções lado a lado (TS x C#, ou antes x depois de uma otimização). Não faz requisição.
// Uso: comando comparar <a> <b>, com o nome ou o caminho dos arquivos .json de results/.
import { renderCompare } from './lib/render.js';

if (!__ENV.A || !__ENV.B) throw new Error('Informe as duas execuções: comparar <a> <b>');

const a = JSON.parse(open(resolve(__ENV.A)));
const b = JSON.parse(open(resolve(__ENV.B)));

export const options = { vus: 1, iterations: 1 };

export default function () {}

export function handleSummary(summary) {
  return { stdout: renderCompare(a, b, { color: summary.state.isStdOutTTY }) };
}

// Aceita "results/x.json", "x.json" ou só "x". O open() é relativo a esta pasta (k6/).
function resolve(arg) {
  let path = arg.replace(/^\.\//, '');
  if (!path.endsWith('.json')) path += '.json';
  if (!path.startsWith('results/')) path = `results/${path}`;
  return `../${path}`;
}
