// Relatórios legíveis: resumo no terminal, página HTML com gráficos e comparação entre duas execuções.

// Cor de cada rota: rápida até FAST_MS, aceitável até SLOW_MS (p95), lenta acima disso.
export const FAST_MS = 100;
export const SLOW_MS = 500;

const NAMES = {
  list: 'Listar tarefas',
  create: 'Criar tarefa',
  update: 'Editar tarefa',
  delete: 'Apagar tarefa',
  login: 'Login',
  register: 'Cadastro',
};

const STATUS = {
  good: { icon: '✓', css: 'good' },
  warn: { icon: '●', css: 'warn' },
  bad: { icon: '✗', css: 'bad' },
};

// ---------- números em português ----------

export function int(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function dec(n, digits = 1) {
  return n.toFixed(digits).replace('.', ',');
}

export function ms(v) {
  if (v == null) return '-';
  if (v === 0) return '0 ms';
  if (v >= 1000) return `${dec(v / 1000, 1)} s`;
  return v < 10 ? `${dec(v, 1)} ms` : `${int(v)} ms`;
}

export function pct(rate) {
  if (rate == null) return '-';
  if (rate === 0) return '0%';
  const p = rate * 100;
  return p < 0.1 ? '<0,1%' : `${dec(p, p < 10 ? 1 : 0)}%`;
}

export function clock(s) {
  const sign = s < -0.5 ? '-' : '';
  const total = Math.abs(Math.round(s));
  const minutes = Math.floor(total / 60);
  return sign + (total >= 600 ? `${minutes} min` : `${minutes}:${String(total % 60).padStart(2, '0')}`);
}

const mb = (v) => (v == null ? '-' : `${int(v)} MB`);
const cores = (v) => (v == null ? '-' : `${dec(v, 1)} ${v >= 2 ? 'núcleos' : 'núcleo'}`);
const perSecond = (v) => `${int(v)} req/s`;

// Dois algarismos significativos, para as manchetes (1.583 vira 1.600).
function round2(v) {
  if (v < 10) return int(v);
  const unit = 10 ** (Math.floor(Math.log10(v)) - 1);
  return int(Math.round(v / unit) * unit);
}

// Data e hora no fuso de quem rodou (o run.sh/run.bat passam UTC_OFFSET, ex.: -0300).
function when(epochMs) {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(__ENV.UTC_OFFSET || '');
  const offset = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const d = new Date(epochMs + offset * 60000);
  const two = (n) => String(n).padStart(2, '0');
  const zone = match ? '' : ' UTC';
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${zone}`;
}

function speedOf(p95) {
  if (p95 <= FAST_MS) return { ...STATUS.good, word: 'rápido' };
  if (p95 <= SLOW_MS) return { ...STATUS.warn, word: 'aceitável' };
  return { ...STATUS.bad, word: 'lento' };
}

function errorsOf(rate) {
  if (rate === 0) return { ...STATUS.good, word: 'nenhum erro' };
  return rate < 0.01 ? { ...STATUS.warn, word: 'poucos erros' } : { ...STATUS.bad, word: 'muitos erros' };
}

// ---------- análise ----------

// Um degrau do teste de capacidade está saudável se respondeu rápido, sem erro e deu conta da carga.
function stepHealth(b) {
  if (!b.count) return { ok: false, reason: 'não respondeu nada' };
  if (b.errorRate > 0.01) return { ok: false, reason: `começou a dar erro (${pct(b.errorRate)} das requisições)` };
  if (b.p95 > SLOW_MS) return { ok: false, reason: `ficou lenta (95% das respostas só em até ${ms(b.p95)})` };
  // Uma rota lenta já estraga a experiência de quem usa ela, mesmo com a média boa.
  const slow = Object.entries(b.endpoints || {})
    .filter(([, e]) => e.p95 > SLOW_MS)
    .sort((x, y) => y[1].p95 - x[1].p95);
  if (slow.length) {
    const [key, e] = slow[0];
    const others = slow.length > 1 ? ` (e mais ${slow.length - 1} ${slow.length > 2 ? 'rotas' : 'rota'})` : '';
    return { ok: false, reason: `${NAMES[key]} ficou lento: 95% em até ${ms(e.p95)}${others}` };
  }
  if (b.rps < 0.9 * b.offeredRps) {
    return {
      ok: false,
      reason:
        `o k6 não conseguiu gerar toda a carga (pediu ${perSecond(b.offeredRps)}, saíram ${perSecond(b.rps)}), ` +
        'mas a API ainda respondia rápido: o limite foi da máquina que roda o teste, não da API',
    };
  }
  return { ok: true };
}

export function analyze(run) {
  const result = {};
  if (run.steps) {
    const steps = run.buckets.map((b) => ({ ...b, health: stepHealth(b) }));
    const broken = steps.find((s) => !s.health.ok) || null;
    const healthy = broken ? steps.filter((s) => s.index < broken.index).pop() || null : steps[steps.length - 1] || null;
    result.capacity = { steps, healthy, broken };
  }
  if (run.test === 'resistencia') {
    const plateau = run.buckets.slice(1, -1).filter((b) => b.count);
    if (plateau.length >= 2) {
      const first = plateau[0];
      const last = plateau[plateau.length - 1];
      result.drift = { from: first.p95, to: last.p95, slower: last.p95 > first.p95 * 1.5 && last.p95 - first.p95 > 20 };
    }
  }
  return result;
}

// Lê o CSV do run.sh/run.bat (tempo, memória em MB, CPU em núcleos) e resume.
export function parseResources(csv, run) {
  let source = '';
  const samples = [];
  for (const line of csv.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      source = line.slice(1).trim();
      continue;
    }
    const [t, memory, cpu] = line.split(',');
    if (!Number.isFinite(Number(t)) || !Number.isFinite(Number(memory)) || t === '' || memory === '') continue;
    samples.push({ t: Number(t) - run.startedAt / 1000, memory: Number(memory), cpu: cpu ? Number(cpu) : null });
  }
  if (!samples.length) return null;
  // Amostras com tempo negativo são de antes do teste, enquanto ele cadastrava os usuários.
  const during = samples.filter((s) => s.t >= 0 && s.t <= run.elapsed);
  const window = during.length ? during : samples;
  const cpus = window.map((s) => s.cpu).filter((v) => v != null && Number.isFinite(v));
  const allCpus = samples.map((s) => s.cpu).filter((v) => v != null && Number.isFinite(v));
  const edge = Math.max(1, Math.floor(window.length * 0.15));
  const avg = (list) => list.reduce((sum, s) => sum + s.memory, 0) / list.length;
  return {
    source,
    idleMb: samples[0].memory,
    peakMb: Math.max(...samples.map((s) => s.memory)),
    endMb: samples[samples.length - 1].memory,
    peakCores: allCpus.length ? Math.max(...allCpus) : null,
    avgCores: cpus.length ? cpus.reduce((sum, v) => sum + v, 0) / cpus.length : null,
    earlyMb: avg(window.slice(0, edge)),
    lateMb: avg(window.slice(-edge)),
    samples: downsample(samples, 400),
  };
}

// Junta amostras vizinhas guardando o maior valor de cada grupo, para o pico não sumir do gráfico.
function downsample(samples, max) {
  const size = Math.ceil(samples.length / max);
  const result = [];
  for (let i = 0; i < samples.length; i += size) {
    const group = samples.slice(i, i + size);
    const cpus = group.map((s) => s.cpu).filter((v) => v != null);
    result.push([
      Math.round(group[0].t * 10) / 10,
      Math.round(Math.max(...group.map((s) => s.memory)) * 10) / 10,
      cpus.length ? Math.round(Math.max(...cpus) * 100) / 100 : null,
    ]);
  }
  return result;
}

function leaking(resources) {
  return resources.lateMb > resources.earlyMb * 1.3 && resources.lateMb - resources.earlyMb > 20;
}

function loadLine(run) {
  const peak = Math.max(...run.buckets.map((b) => b.targetRps));
  if (run.steps) {
    const first = run.buckets[0] ? run.buckets[0].targetRps : 0;
    return `Carga subindo em degraus de ${run.bucketSeconds} s, de ~${round2(first)} até ~${round2(peak)} req/s`;
  }
  return `Carga de ~${round2(peak)} req/s por ${clock(run.plannedSeconds)} (≈ ${round2(peak)} usuários fazendo 1 ação por segundo)`;
}

// ---------- terminal ----------

export function paint(on) {
  const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap('1'), dim: wrap('2'), good: wrap('32'), warn: wrap('33'), bad: wrap('31') };
}

export function renderText(run, { color = false, file = '' } = {}) {
  const c = paint(color);
  const mark = (status) => c[status.css](status.icon);
  const a = analyze(run);
  const lines = ['', c.dim('─'.repeat(64)), `  ${c.bold(run.api)} · ${run.title} · ${when(run.finishedAt)}`, c.dim('─'.repeat(64)), ''];
  lines.push(`  ${loadLine(run)}`);
  if (run.checklist === 'falhou') lines.push(c.warn('  ⚠ A API ainda não passa no checklist da spec (comando checklist).'));
  if (run.stoppedEarly && !run.steps) lines.push(c.warn(`  ⚠ O teste parou antes do fim (${clock(run.elapsed)} de ${clock(run.plannedSeconds)}).`));
  lines.push('');

  if (a.capacity) {
    const { healthy, broken, steps } = a.capacity;
    if (!healthy) {
      lines.push(`  ${mark(STATUS.bad)} ${c.bold(`Não aguentou nem o primeiro degrau (~${round2(steps[0].targetRps)} req/s)`)}: ${broken.health.reason}.`);
    } else if (!broken) {
      lines.push(`  ${mark(STATUS.good)} ${c.bold(`Aguentou toda a carga testada: ~${round2(healthy.rps)} req/s`)} (≈ ${round2(healthy.rps)} usuários fazendo 1 ação por segundo).`);
      lines.push(c.dim(`    Para achar o limite, aumente RATE no .env (agora está ${run.rate}).`));
    } else {
      lines.push(`  ${mark(STATUS.good)} ${c.bold(`Aguentou até ~${round2(healthy.rps)} req/s`)} (≈ ${round2(healthy.rps)} usuários fazendo 1 ação por segundo).`);
      lines.push(`    Com ~${round2(broken.targetRps)} req/s, ${broken.health.reason}.`);
    }
    lines.push('', `  ${pad('Degrau', 8)}${padL('pedido', 11)}${padL('atendido', 11)}${padL('normal', 9)}${padL('95% até', 10)}${padL('erros', 8)}`);
    for (const s of steps) {
      const status = s.health.ok ? STATUS.good : STATUS.bad;
      lines.push(
        `  ${mark(status)} ${pad(String(s.index + 1), 6)}${padL(`${int(s.targetRps)}/s`, 11)}${padL(`${int(s.rps)}/s`, 11)}` +
          `${padL(ms(s.p50), 9)}${padL(ms(s.p95), 10)}${padL(pct(s.errorRate), 8)}`,
      );
    }
  } else {
    const o = run.totals.overall || {};
    lines.push(`  ${mark(speedOf(o.p95))} Velocidade: normalmente ${ms(o.p50)}; 95% das respostas em até ${ms(o.p95)}`);
  }

  const errors = Math.round(run.totals.requests * run.totals.errorRate);
  const errorStatus = errorsOf(run.totals.errorRate);
  lines.push(`  ${mark(errorStatus)} Erros: ${errors ? `${pct(run.totals.errorRate)} (${int(errors)} de ${int(run.totals.requests)} requisições)` : `nenhum em ${int(run.totals.requests)} requisições`}`);

  const r = run.resources;
  if (r) {
    lines.push(`  ${c.dim('●')} Memória: ${mb(r.idleMb)} antes do teste, pico de ${mb(r.peakMb)}`);
    if (r.peakCores != null) lines.push(`  ${c.dim('●')} CPU: pico de ${cores(r.peakCores)}, média de ${cores(r.avgCores)}`);
    if (run.test === 'resistencia') {
      lines.push(
        leaking(r)
          ? c.warn(`  ⚠ A memória subiu de ~${mb(r.earlyMb)} para ~${mb(r.lateMb)} ao longo do teste: pode ser vazamento.`)
          : `  ${mark(STATUS.good)} Memória estável ao longo do teste (~${mb(r.earlyMb)} no começo, ~${mb(r.lateMb)} no fim).`,
      );
    }
  } else {
    lines.push(c.dim('  · Memória e CPU: não deu para medir (a API precisa rodar nesta máquina).'));
  }
  if (a.drift) {
    lines.push(
      a.drift.slower
        ? c.warn(`  ⚠ Ficou mais lenta com o tempo: 95% em até ${ms(a.drift.from)} no começo e ${ms(a.drift.to)} no fim.`)
        : `  ${mark(STATUS.good)} Velocidade estável: 95% em até ${ms(a.drift.from)} no começo e ${ms(a.drift.to)} no fim.`,
    );
  }

  if (!run.steps) {
    lines.push('', `  ${pad('Rota', 20)}${padL('normal', 9)}${padL('95% até', 10)}${padL('erros', 8)}`);
    for (const [key, e] of Object.entries(run.endpoints)) {
      lines.push(`  ${mark(speedOf(e.p95))} ${pad(NAMES[key], 18)}${padL(ms(e.p50), 9)}${padL(ms(e.p95), 10)}${padL(pct(e.errorRate), 8)}`);
    }
    lines.push(c.dim(`  ${STATUS.good.icon} rápido (até ${FAST_MS} ms)   ${STATUS.warn.icon} aceitável (até ${SLOW_MS} ms)   ${STATUS.bad.icon} lento`));
  }
  if (file) lines.push('', `  Relatório com gráficos: ${c.bold(file)}`);
  return `${lines.join('\n')}\n\n`;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function padL(s, n) {
  return String(s).padStart(n);
}

// ---------- comparação ----------

export function renderCompare(a, b, { color = false } = {}) {
  const c = paint(color);
  const lines = ['', `  ${c.bold('A')}: ${a.api} · ${a.title} · ${when(a.finishedAt)}`, `  ${c.bold('B')}: ${b.api} · ${b.title} · ${when(b.finishedAt)}`, ''];
  const same = (key) => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null);
  if (!['test', 'rate', 'duration', 'rotas'].every(same)) {
    lines.push(c.warn('  ⚠ As duas execuções não usaram os mesmos parâmetros (teste, RATE, DURATION ou ROTAS): a comparação não é justa.'));
  }
  for (const run of [a, b]) {
    if (run.checklist === 'falhou') lines.push(c.warn(`  ⚠ ${run.api} não passou no checklist da spec.`));
  }
  if (lines[lines.length - 1] !== '') lines.push('');

  const rows = [];
  // lower = true quando menor é melhor. Diferença menor que minDiff (ou que 5%) conta como empate.
  const row = (label, va, vb, format, minDiff = 0, lower = true) => rows.push({ label, va, vb, format, minDiff, lower });
  if (a.steps && b.steps) {
    const ca = analyze(a).capacity;
    const cb = analyze(b).capacity;
    row('Aguentou até', ca.healthy ? ca.healthy.rps : 0, cb.healthy ? cb.healthy.rps : 0, perSecond, 0, false);
  } else {
    const oa = a.totals.overall || {};
    const ob = b.totals.overall || {};
    row('Resposta normal', oa.p50, ob.p50, ms, 1);
    row('95% das respostas em até', oa.p95, ob.p95, ms, 1);
  }
  row('Erros', a.totals.errorRate, b.totals.errorRate, pct);
  row('Memória no pico', a.resources && a.resources.peakMb, b.resources && b.resources.peakMb, mb, 5);
  row('CPU no pico', a.resources && a.resources.peakCores, b.resources && b.resources.peakCores, cores, 0.1);
  for (const key of Object.keys(NAMES)) {
    if (a.endpoints[key] || b.endpoints[key]) {
      row(`${NAMES[key]} (95% até)`, a.endpoints[key] && a.endpoints[key].p95, b.endpoints[key] && b.endpoints[key].p95, ms, 1);
    }
  }

  lines.push(`  ${pad('', 28)}${padL('A', 12)}${padL('B', 12)}   melhor`);
  for (const r of rows) {
    const show = (v) => (v == null ? '-' : r.format(v));
    lines.push(`  ${pad(r.label, 28)}${padL(show(r.va), 12)}${padL(show(r.vb), 12)}   ${winner(r)}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function winner({ va, vb, lower, minDiff }) {
  if (va == null || vb == null) return '';
  if (Math.abs(va - vb) < minDiff || va === vb) return 'empate';
  const best = (lower ? va < vb : va > vb) ? 'A' : 'B';
  const [good, bad] = best === 'A' ? [va, vb] : [vb, va];
  const diff = lower ? (bad - good) / bad : (good - bad) / (bad || 1);
  if (diff < 0.05) return 'empate';
  return lower ? `${best}, ${dec(diff * 100, 0)}% menor` : `${best}, ${dec(diff * 100, 0)}% maior`;
}

// ---------- HTML ----------

export function renderHtml(run) {
  const a = analyze(run);
  const o = run.totals.overall || {};
  const r = run.resources;
  const parts = [];

  parts.push(`<header><h1>${esc(run.api)} · ${esc(run.title)}</h1>
    <p class="sub">${esc(when(run.finishedAt))} · ${esc(run.baseUrl)}</p>
    <p class="sub">${esc(loadLine(run))}</p></header>`);

  const notes = [];
  if (run.checklist === 'falhou') notes.push('A API ainda não passa no checklist da spec (comando <code>checklist</code>).');
  if (run.stoppedEarly && !run.steps) notes.push(`O teste parou antes do fim (${clock(run.elapsed)} de ${clock(run.plannedSeconds)}).`);
  if (notes.length) parts.push(`<div class="alert">${notes.map((n) => `<p>⚠ ${n}</p>`).join('')}</div>`);

  if (a.capacity) {
    const { healthy, broken, steps } = a.capacity;
    let hero;
    let detail = '';
    if (!healthy) {
      hero = `Não aguentou nem ~${round2(steps[0].targetRps)} req/s`;
      detail = `No primeiro degrau, ${esc(broken.health.reason)}.`;
    } else {
      hero = `Aguentou até ~${round2(healthy.rps)} req/s`;
      detail = `≈ ${round2(healthy.rps)} usuários fazendo uma ação por segundo, com 95% das respostas em até ${ms(healthy.p95)}.`;
      detail += broken
        ? ` Com ~${round2(broken.targetRps)} req/s, ${esc(broken.health.reason)}.`
        : ` Não quebrou: para achar o limite, aumente RATE no .env (agora está ${run.rate}).`;
    }
    parts.push(`<section class="verdict"><p class="label">Capacidade</p><p class="hero">${hero}</p><p>${detail}</p></section>`);
  }

  const tiles = [];
  if (!run.steps) {
    tiles.push(tile('Resposta normal', ms(o.p50), 'metade respondeu mais rápido que isso'));
    tiles.push(tile('95% das respostas em até', ms(o.p95), statusText(speedOf(o.p95))));
  }
  const errors = Math.round(run.totals.requests * run.totals.errorRate);
  tiles.push(tile('Erros', pct(run.totals.errorRate), `${int(errors)} de ${int(run.totals.requests)} requisições`));
  if (r) {
    tiles.push(tile('Memória no pico', mb(r.peakMb), `${mb(r.idleMb)} antes do teste`));
    if (r.peakCores != null) tiles.push(tile('CPU no pico', cores(r.peakCores), `média de ${cores(r.avgCores)}`));
  } else {
    tiles.push(tile('Memória e CPU', '-', 'não deu para medir: a API precisa rodar nesta máquina'));
  }
  parts.push(`<section class="tiles">${tiles.join('')}</section>`);

  if (run.test === 'resistencia' && (a.drift || r)) {
    const items = [];
    if (a.drift) {
      items.push(
        a.drift.slower
          ? `⚠ Ficou mais lenta com o tempo: 95% em até ${ms(a.drift.from)} no começo e ${ms(a.drift.to)} no fim.`
          : `✓ Velocidade estável: 95% em até ${ms(a.drift.from)} no começo e ${ms(a.drift.to)} no fim.`,
      );
    }
    if (r) {
      items.push(
        leaking(r)
          ? `⚠ A memória subiu de ~${mb(r.earlyMb)} para ~${mb(r.lateMb)} ao longo do teste: pode ser vazamento.`
          : `✓ Memória estável: ~${mb(r.earlyMb)} no começo e ~${mb(r.lateMb)} no fim.`,
      );
    }
    parts.push(`<section class="card"><h2>Ao longo do tempo</h2>${items.map((i) => `<p>${i}</p>`).join('')}</section>`);
  }

  const buckets = run.buckets.filter((b) => b.count || run.steps);
  const xLabel = (b) => (run.steps ? `${int(b.targetRps)}/s` : clock(b.start + b.length));
  const tipLabel = (b) => (run.steps ? `Degrau ${b.index + 1} · carga de ~${int(b.targetRps)} req/s` : `Até ${clock(b.start + b.length)}`);
  // No teste de capacidade, a rota mais lenta de cada degrau: a média geral esconde uma rota lenta.
  const slowest = (b) =>
    Object.entries(b.endpoints || {}).reduce((worst, [key, e]) => (!worst || e.p95 > worst.p95 ? { key, p95: e.p95 } : worst), null);
  const latency = run.steps
    ? [
        { name: '95% em até, geral', key: 'Geral', slot: 1, values: buckets.map((b) => b.p95), format: ms },
        {
          name: '95% em até, rota mais lenta',
          key: 'Mais lenta',
          slot: 2,
          values: buckets.map((b) => (slowest(b) ? slowest(b).p95 : null)),
          format: ms,
          text: buckets.map((b) => (slowest(b) ? `${ms(slowest(b).p95)} (${NAMES[slowest(b).key]})` : '-')),
        },
      ]
    : [
        { name: 'Normal (metade foi mais rápida)', key: 'Normal', slot: 1, values: buckets.map((b) => b.p50), format: ms },
        { name: '95% em até', key: '95%', slot: 2, values: buckets.map((b) => b.p95), format: ms },
      ];
  const maxP95 = Math.max(0, ...latency.flatMap((s) => s.values).filter((v) => v != null));
  parts.push(
    chartCard({
      title: 'Tempo de resposta',
      hint: run.steps
        ? `Em cada degrau de carga: em quanto tempo 95% das respostas chegaram, no geral e na rota mais lenta. Acima de ${SLOW_MS} ms, a rota conta como lenta.`
        : `A cada ${run.bucketSeconds} s: quanto as respostas demoraram.`,
      xTitle: run.steps ? 'Carga pedida' : 'Tempo',
      points: buckets.map((b) => ({ x: run.steps ? b.index : b.start + b.length, label: xLabel(b), tip: tipLabel(b) })),
      series: latency,
      threshold: maxP95 > SLOW_MS / 2 ? { value: SLOW_MS, label: `limite de ${SLOW_MS} ms` } : null,
      yFormat: ms,
      dots: run.steps,
    }),
  );
  parts.push(
    chartCard({
      title: 'Requisições por segundo',
      hint: 'O que o teste pediu e o que a API conseguiu atender. Se as linhas se separam, a API não deu conta.',
      xTitle: run.steps ? 'Carga pedida' : 'Tempo',
      points: buckets.map((b) => ({ x: run.steps ? b.index : b.start + b.length, label: xLabel(b), tip: tipLabel(b) })),
      series: [
        { name: 'Pedido', key: 'Pedido', slot: 1, values: buckets.map((b) => b.offeredRps), format: perSecond },
        { name: 'Atendido', key: 'Atendido', slot: 2, values: buckets.map((b) => b.rps), format: perSecond },
      ],
      yFormat: (v) => int(v),
      dots: run.steps,
    }),
  );
  if (r && r.samples.length > 1) {
    const points = r.samples.map(([t]) => ({ x: t, label: clock(t), tip: `Aos ${clock(t)}` }));
    parts.push(
      chartCard({
        title: 'Memória da API',
        hint: `Memória usada pelo ${esc(r.source || 'processo da API')}. Antes do teste: ${mb(r.idleMb)}. Tempo negativo é antes do teste começar, enquanto ele cadastra os usuários de teste.`,
        xTitle: 'Tempo',
        points,
        series: [{ name: 'Memória', key: 'Memória', slot: 1, values: r.samples.map((s) => s[1]), format: mb }],
        yFormat: (v) => `${int(v)} MB`,
      }),
    );
    if (r.peakCores != null) {
      parts.push(
        chartCard({
          title: 'CPU da API',
          hint: '1 núcleo = um núcleo do processador 100% ocupado. Tempo negativo é antes do teste começar.',
          xTitle: 'Tempo',
          points,
          series: [{ name: 'CPU', key: 'CPU', slot: 1, values: r.samples.map((s) => s[2]), format: cores }],
          yFormat: (v) => dec(v, 1),
        }),
      );
    }
  }

  if (a.capacity) {
    const rowsHtml = a.capacity.steps
      .map((s) => {
        const status = s.health.ok ? { ...STATUS.good, word: 'aguentou' } : { ...STATUS.bad, word: 'não aguentou' };
        return `<tr><td>${s.index + 1}</td><td>${int(s.targetRps)}/s</td><td>${int(s.rps)}/s</td><td>${ms(s.p50)}</td><td>${ms(s.p95)}</td><td>${pct(s.errorRate)}</td><td>${statusHtml(status)}</td></tr>`;
      })
      .join('');
    parts.push(`<section class="card"><h2>Degraus</h2><p class="hint">Cada degrau dura ${run.bucketSeconds} s e pede o dobro do anterior. Um degrau só conta como aguentado se todas as rotas ficaram com 95% em até ${SLOW_MS} ms, quase sem erro e sem deixar carga para trás.</p>
      <table><thead><tr><th>Degrau</th><th>Pedido</th><th>Atendido</th><th>Normal</th><th>95% em até</th><th>Erros</th><th>Resultado</th></tr></thead><tbody>${rowsHtml}</tbody></table></section>`);
  }

  const routeRows = Object.entries(run.endpoints)
    .map(([key, e]) => `<tr><td>${NAMES[key]}</td><td>${ms(e.p50)}</td><td>${ms(e.p95)}</td><td>${ms(e.max)}</td><td>${pct(e.errorRate)}</td><td>${statusHtml(speedOf(e.p95))}</td></tr>`)
    .join('');
  parts.push(`<section class="card"><h2>Rotas</h2><p class="hint">${run.steps ? 'Somando todos os degraus.' : 'Durante o teste todo.'}</p>
    <table><thead><tr><th>Rota</th><th>Normal</th><th>95% em até</th><th>Mais lenta</th><th>Erros</th><th>Velocidade</th></tr></thead><tbody>${routeRows}</tbody></table></section>`);

  parts.push(`<section class="card glossary"><h2>Como ler</h2><dl>
    <dt>Normal</dt><dd>Metade das requisições respondeu mais rápido que isso (mediana).</dd>
    <dt>95% em até</dt><dd>Só 1 em cada 20 requisições demorou mais que isso. É o número que mostra os casos ruins.</dd>
    <dt>Velocidade</dt><dd>${STATUS.good.icon} rápido: 95% em até ${FAST_MS} ms. ${STATUS.warn.icon} aceitável: até ${SLOW_MS} ms. ${STATUS.bad.icon} lento: mais que isso.</dd>
    <dt>req/s</dt><dd>Requisições por segundo. "Usuários" é uma estimativa: cada usuário fazendo uma ação por segundo.</dd>
    <dt>Memória e CPU</dt><dd>Medidas no processo (ou container) da API enquanto o teste rodava.</dd>
  </dl></section>`);

  return page(`${run.api} · ${run.title}`, parts.join('\n'));
}

function tile(label, value, note) {
  return `<div class="tile"><p class="label">${esc(label)}</p><p class="value">${esc(value)}</p><p class="note">${esc(note)}</p></div>`;
}

function statusText(status) {
  return `${status.icon} ${status.word}`;
}

function statusHtml(status) {
  return `<span class="status"><span class="icon ${status.css}" aria-hidden="true">${status.icon}</span>${esc(status.word)}</span>`;
}

// Gráfico de linhas em SVG, com cruz de leitura e tooltip (mouse ou setas do teclado) e a tabela dos números.
function chartCard({ title, hint, xTitle, points, series, threshold = null, yFormat, dots = false }) {
  const W = 720;
  const H = 260;
  const m = { l: 64, r: 24, t: 16, b: 34 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const px = (x) => m.l + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const values = series.flatMap((s) => s.values).filter((v) => v != null);
  const scale = niceScale(Math.max(threshold ? threshold.value : 0, ...values));
  const py = (v) => m.t + plotH - (v / scale.max) * plotH;

  const svg = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = py(v).toFixed(1);
    svg.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`);
    svg.push(`<text class="tick" x="${m.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(yFormat(v))}</text>`);
  }
  svg.push(`<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + plotH}" y2="${m.t + plotH}"/>`);
  const tickEvery = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, i) => {
    if (i % tickEvery === 0 || i === points.length - 1) {
      svg.push(`<text class="tick" x="${px(p.x).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(p.label)}</text>`);
    }
  });
  if (threshold) {
    const y = py(threshold.value).toFixed(1);
    svg.push(`<line class="limit" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`);
    svg.push(`<text class="limit-label" x="${m.l + 6}" y="${(py(threshold.value) - 6).toFixed(1)}">${esc(threshold.label)}</text>`);
  }
  const ends = [];
  for (const s of series) {
    let d = '';
    let open = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        open = false;
        return;
      }
      d += `${open ? 'L' : 'M'}${px(points[i].x).toFixed(1)} ${py(v).toFixed(1)} `;
      open = true;
    });
    svg.push(`<path class="line s${s.slot}" d="${d.trim()}"/>`);
    const marks = dots ? s.values.map((v, i) => [v, i]) : [[s.values[s.values.length - 1], s.values.length - 1]];
    for (const [v, i] of marks) {
      if (v != null) svg.push(`<circle class="dot s${s.slot}" cx="${px(points[i].x).toFixed(1)}" cy="${py(v).toFixed(1)}" r="4"/>`);
    }
    const last = [...s.values].reverse().find((v) => v != null);
    if (last != null) ends.push({ key: s.key, y: py(last) });
  }
  // Nome no fim de cada linha, só quando os nomes não se encostam (senão ficam a legenda e o tooltip).
  if (series.length > 1 && ends.every((e, i) => ends.every((f, j) => i === j || Math.abs(e.y - f.y) >= 14))) {
    for (const e of ends) svg.push(`<text class="end-label" x="${W - m.r + 2}" y="${e.y.toFixed(1)}" dominant-baseline="middle">${esc(e.key)}</text>`);
  }
  svg.push(`<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + plotH}" visibility="hidden"/>`);
  svg.push(`<rect class="hit" x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}"/>`);

  const legend =
    series.length > 1
      ? `<ul class="legend">${series.map((s) => `<li><span class="key s${s.slot}"></span>${esc(s.name)}</li>`).join('')}</ul>`
      : '';
  const data = {
    width: W,
    px: points.map((p) => Number(px(p.x).toFixed(1))),
    labels: points.map((p) => p.tip),
    series: series.map((s) => ({ name: s.name, slot: s.slot, text: s.text || s.values.map((v) => (v == null ? '-' : s.format(v))) })),
  };
  const table = `<details><summary>Ver os números</summary><table><thead><tr><th>${esc(xTitle)}</th>${series
    .map((s) => `<th>${esc(s.name)}</th>`)
    .join('')}</tr></thead><tbody>${points
    .map((p, i) => `<tr><td>${esc(p.label)}</td>${data.series.map((s) => `<td>${esc(s.text[i])}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></details>`;

  return `<section class="card"><h2>${esc(title)}</h2><p class="hint">${hint}</p>${legend}
    <figure class="chart" tabindex="0" aria-label="${esc(title)}: use as setas para ler os valores">
      <svg viewBox="0 0 ${W + 40} ${H}" role="img" aria-label="${esc(title)}">${svg.join('')}</svg>
      <div class="tip" hidden></div>
      <script type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
    </figure>${table}</section>`;
}

function niceScale(max) {
  const top = max > 0 ? max : 1;
  const raw = top / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw);
  return { step, max: step * Math.ceil(top / step - 1e-9) };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function page(title, body) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11, 11, 11, 0.10);
  --s1: #2a78d6; --s2: #eb6834; --good: #0ca30c; --warn: #fab219; --bad: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255, 255, 255, 0.10);
    --s1: #3987e5; --s2: #d95926;
  }
}
* { box-sizing: border-box; }
body.viz-root { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0 0 4px; }
p { margin: 0; }
.sub, .hint, .label { color: var(--ink-2); }
.hint { font-size: 13px; margin-bottom: 12px; }
header { margin-bottom: 20px; }
.alert { border: 1px solid var(--border); border-left: 4px solid var(--warn); background: var(--surface); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
.verdict { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
.verdict .hero { font-size: 44px; font-weight: 600; line-height: 1.15; margin: 4px 0 8px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile, .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.tile { padding: 14px 16px; }
.tile .label { font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 600; margin: 2px 0; }
.tile .note { font-size: 12px; color: var(--muted); }
.card { padding: 18px 20px; margin-bottom: 16px; }
.card > p + p { margin-top: 6px; }
.legend { display: flex; gap: 16px; list-style: none; padding: 0; margin: 0 0 6px; font-size: 13px; color: var(--ink-2); }
.legend li { display: flex; align-items: center; gap: 6px; }
.key { display: inline-block; width: 16px; height: 2px; border-radius: 1px; }
.key.s1 { background: var(--s1); } .key.s2 { background: var(--s2); }
.chart { position: relative; margin: 0; outline: none; }
.chart:focus-visible { box-shadow: 0 0 0 2px var(--s1); border-radius: 8px; }
.chart svg { display: block; width: 100%; height: auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick, .end-label, .limit-label { fill: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.end-label { fill: var(--ink-2); }
.limit { stroke: var(--bad); stroke-width: 1; stroke-dasharray: 4 4; }
.line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.line.s1 { stroke: var(--s1); } .line.s2 { stroke: var(--s2); }
.dot { stroke: var(--surface); stroke-width: 2; }
.dot.s1 { fill: var(--s1); } .dot.s2 { fill: var(--s2); }
.cross { stroke: var(--axis); stroke-width: 1; }
.hit { fill: transparent; cursor: crosshair; }
.tip { position: absolute; top: 8px; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); min-width: 150px; }
.tip-x { color: var(--ink-2); margin-bottom: 4px; }
.tip-row { display: flex; align-items: center; gap: 8px; }
.tip-row strong { font-variant-numeric: tabular-nums; }
.tip-row span:last-child { color: var(--ink-2); }
details { margin-top: 8px; font-size: 13px; }
summary { cursor: pointer; color: var(--ink-2); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--axis); padding: 6px 8px; }
td { border-bottom: 1px solid var(--grid); padding: 6px 8px; font-variant-numeric: tabular-nums; }
.status { display: inline-flex; align-items: center; gap: 6px; }
.icon { font-weight: 700; }
.icon.good { color: var(--good); } .icon.warn { color: var(--warn); } .icon.bad { color: var(--bad); }
.glossary dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14px; }
.glossary dt { font-weight: 600; }
.glossary dd { margin: 0; color: var(--ink-2); }
code { font-size: 13px; }
</style>
</head>
<body class="viz-root">
<main>
${body}
</main>
<script>
document.querySelectorAll('figure.chart').forEach((fig) => {
  const data = JSON.parse(fig.querySelector('script[type="application/json"]').textContent);
  const svg = fig.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const tip = fig.querySelector('.tip');
  let index = data.px.length - 1;
  const show = (i) => {
    index = i;
    const x = data.px[i];
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-x';
    head.textContent = data.labels[i];
    tip.append(head);
    for (const s of data.series) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'key s' + s.slot;
      const value = document.createElement('strong');
      value.textContent = s.text[i];
      const name = document.createElement('span');
      name.textContent = s.name;
      row.append(key, value, name);
      tip.append(row);
    }
    tip.hidden = false;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const left = x * scale;
    const right = left + tip.offsetWidth + 12 > fig.clientWidth;
    tip.style.left = (right ? left - tip.offsetWidth - 12 : left + 12) + 'px';
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    let best = 0;
    data.px.forEach((p, i) => { if (Math.abs(p - x) < Math.abs(data.px[best] - x)) best = i; });
    show(best);
  });
  svg.addEventListener('pointerleave', hide);
  fig.addEventListener('focus', () => show(index));
  fig.addEventListener('blur', hide);
  fig.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(Math.max(0, index - 1));
    if (event.key === 'ArrowRight') show(Math.min(data.px.length - 1, index + 1));
  });
});
</script>
</body>
</html>
`;
}
