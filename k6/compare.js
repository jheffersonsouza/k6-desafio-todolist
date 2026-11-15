// Compara dois resultados do load.js lado a lado (Java x C#, ou antes x depois de uma otimização):
//   k6 run -q -e A=results/java_load_....json -e B=results/csharp_load_....json compare.js
// Não faz requisição nenhuma: só lê os dois arquivos e imprime a tabela.
import { compareReport } from './lib/report.js';

if (!__ENV.A || !__ENV.B) throw new Error('Informe os dois resultados: -e A=results/<a>.json -e B=results/<b>.json');

const a = JSON.parse(open(__ENV.A));
const b = JSON.parse(open(__ENV.B));

export const options = { vus: 1, iterations: 1 };

export default function () {}

export function handleSummary() {
  return { stdout: compareReport(a, b) };
}
