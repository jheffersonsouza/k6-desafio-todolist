# k6-desafio-todolist

Testes de carga e um checklist da spec para o desafio [Todo List API do roadmap.sh](https://roadmap.sh/projects/todo-list-api), feitos com [k6](https://grafana.com/docs/k6/latest/). Você roda um comando e acompanha tudo num painel do Grafana, ao vivo: quanto tempo a API demora para responder, quanto ela aguenta, quantos erros deu e quanta memória e CPU usou.

> Este repositório foi gerado inteiramente com IA (Claude Code). A ideia é usar a mesma suite para testar as duas implementações do desafio, uma em TypeScript (Bun) e outra em C#. Os testes só falam HTTP com a API, então servem para qualquer linguagem que siga a spec.

## Como rodar

Só precisa de Docker (no Windows e no macOS, o Docker Desktop).

1. Clone o repositório:

   ```bash
   git clone https://github.com/jheffersonsouza/k6-desafio-todolist.git
   cd k6-desafio-todolist
   ```

2. Suba a sua API.
3. Rode `./run.sh` (Linux, macOS ou Git Bash) ou `run.bat` (Windows). Na primeira vez ele cria o `.env`: ajuste `API` (seu nome no painel) e a porta da `BASE_URL`, e rode de novo.
4. Abra o painel em **http://localhost:3030** e acompanhe o teste ao vivo.

Na primeira vez o Docker baixa as imagens do k6, do Grafana e do InfluxDB, então demora um pouco mais.

## Comandos

| comando | o que faz | duração |
| --- | --- | --- |
| `dev` (padrão) | Checklist da spec e um teste rápido numa carga normal. | ~1 min 30 s |
| `capacidade` | Sobe a carga em degraus até a API não dar conta: mostra quanto ela aguenta. | até ~4 min |
| `resistencia` | 30 minutos de carga constante, para ver se a memória ou a velocidade pioram com o tempo. | ~32 min |
| `checklist` | O que a API já faz da spec e o que ainda falta. | segundos |
| `comparar A B` | Compara dois resultados no terminal (TS x C#, ou antes x depois de uma mudança). | segundos |
| `painel` | Abre o painel no navegador (ele sobe sozinho com qualquer teste). | |
| `parar` | Para o teste que estiver rodando. Ctrl+C também serve. | |
| `desligar` | Desliga o painel. O histórico continua guardado. | |

Exemplos: `./run.sh capacidade`, `run.bat checklist`, `./run.sh comparar ts_dev_2026-11-14-21-12-19 csharp_dev_2026-11-14-22-03-10`.

## O painel

Em http://localhost:3030, atualizando a cada 5 segundos:

- **Números principais**: resposta normal, 95% em até, erros, requisições, memória e CPU no pico e, no teste de capacidade, até quanto a API aguentou.
- **Gráficos ao vivo**: tempo de resposta (com a linha vermelha dos 500 ms), requisições por segundo, erros, memória e CPU da API.
- **Por rota**: Listar, Criar, Editar, Apagar, Login e Cadastro, cada uma com seu tempo e seus erros. A cor mostra a velocidade: verde até 100 ms, amarelo até 500 ms, vermelho acima.
- **Execuções**: o histórico dos testes. Clique no horário de uma execução para ver só ela.
- **Comparar**: escolha duas ou mais execuções no seletor **Execução**, lá em cima. Cada número aparece uma vez por execução, lado a lado.

Como ler os números:

- **Normal** é o tempo em que metade das respostas chegou. **95% em até** mostra os casos ruins: só 1 em cada 20 respostas demorou mais que isso.
- **Aguentou até** (teste de capacidade) é a maior carga em que todas as rotas responderam com 95% em até 500 ms, quase sem erro e dando conta de tudo que foi pedido.
- **Memória e CPU** são medidas no processo da API, ou no container dela. Só aparecem com a API rodando na mesma máquina do teste. CPU vem em núcleos: 1 núcleo é um núcleo do processador 100% ocupado.

No fim de cada teste também sai um resumo no terminal e um relatório em `results/<api>_<teste>_<data>.html`, um arquivo só que dá para mandar para o outro abrir no navegador.

## Comparação justa (TS x C#)

Resultados de PCs diferentes não se comparam, porque hardware diferente dá número diferente. Cada um pode usar a suite no próprio PC para acompanhar a evolução da sua API. Já o duelo precisa das duas APIs rodando na mesma máquina, uma de cada vez. Por exemplo, um de vocês clona a API do outro e roda as duas.

O ambiente e a configuração pesam mais no resultado do que a linguagem. Antes da rodada que vale, combinem:

- **Uma API por vez**, sem nada pesado rodando junto.
- **Mesma CPU disponível.** O Bun roda o JavaScript numa thread só por processo, enquanto o Kestrel usa todos os núcleos. Rodem as duas APIs em Docker com o mesmo limite (ex.: `docker run --cpus=2 --memory=1g`), ou subam vários processos do Bun com `reusePort`.
- **Mesmo banco de verdade**, de preferência o mesmo PostgreSQL em Docker, zerado antes de cada rodada. Um `Map` em memória contra um banco real não é comparação. O teste cria usuários e tarefas novos a cada execução.
- **Mesmo hash de senha, com o mesmo custo.** Ele domina o tempo de login e cadastro. `Bun.password.hash()` usa argon2id por padrão; para bcrypt, passe `{ algorithm: "bcrypt", cost: 10 }`. `BCrypt.Net.BCrypt.HashPassword` usa bcrypt com custo 11 por padrão (o dobro do trabalho do custo 10). O ASP.NET Identity usa PBKDF2, que é outro algoritmo.
- **Mesmo tamanho de pool de conexões.** O Npgsql vem com 100; os drivers de Postgres para Bun e Node costumam vir com 10.
- **Modo de produção**: `dotnet run -c Release` (ou `publish`) e o Bun sem `--watch`.
- **Sem log por requisição** e sem SQL no console.
- **Aquecimento.** As duas plataformas otimizam o código enquanto ele roda (JIT). Rodem um `dev` e descartem antes da rodada oficial.
- **Validade do token maior que o teste.** O `resistencia` dura 32 minutos.
- **Rate limiting desligado** (é bônus da spec). Ligado, o teste mede o rate limiter.
- **Mesmos parâmetros** no `.env`. O `comparar` avisa quando são diferentes.

No `capacidade`, login e cadastro costumam pesar primeiro por causa do hash. Para achar o limite só do CRUD, rodem também com `ROTAS=listar,gravar`.

## O que a API precisa seguir

| rota | sucesso | erro |
| --- | --- | --- |
| `POST /register` `{ name, email, password }` | 200/201 `{ token }` | 4xx para e-mail repetido ou dados faltando |
| `POST /login` `{ email, password }` | 200 `{ token }` | 4xx para credenciais erradas |
| `POST /todos` `{ title, description }` | 200/201 `{ id, title, description }` | 401 sem token, 4xx sem `title` |
| `PUT /todos/{id}` `{ title, description }` | 200 `{ id, title, description }` | 401 sem token, 403 se não for o dono |
| `DELETE /todos/{id}` | 204 | 401 sem token, 4xx se não for o dono |
| `GET /todos?page=1&limit=10` | 200 `{ data, page, limit, total }` | 401 sem token |

O token vai em `Authorization: Bearer <token>`. A spec fala em mandar o token puro no header. Se for o caso, use `AUTH_SCHEME=none`. O importante é vocês dois usarem o mesmo formato.

No checklist, os itens obrigatórios vêm da spec. Os recomendados são boas práticas que a spec não define, como 409 para e-mail repetido ou 404 para id inexistente. Antes de cada teste de carga o checklist roda num modo resumido: ele não impede o teste, mas o painel e o relatório avisam quando a API ainda não passa nele.

Os testes de carga precisam do cadastro devolvendo token e das rotas de `/todos` funcionando: antes de começar, eles cadastram 50 usuários com 25 tarefas cada.

Se o teste não conseguir conectar: no Linux, a API precisa escutar em `0.0.0.0`, não só em `localhost`. Bun e Spring já fazem isso. No ASP.NET, rode com `--urls http://0.0.0.0:<porta>`.

## Configuração (.env)

| variável | padrão | uso |
| --- | --- | --- |
| `API` | `api` | Nome que aparece no painel e nos relatórios (`ts`, `csharp`...). |
| `BASE_URL` | `http://host.docker.internal:8080` | Endereço da API visto de dentro do container. Troque só a porta. |
| `RATE` | `100` | Carga base. Com todas as rotas, 100 dá uns 160 req/s. No `capacidade`, os degraus vão de 1/4 a 32 vezes isso. |
| `DURATION` | do teste | Duração da parte principal: o patamar do `dev` (1m) e do `resistencia` (30m), ou cada degrau do `capacidade` (30s). |
| `ROTAS` | `listar,gravar,login,cadastro` | Quais rotas testar. `gravar` é criar, editar e apagar uma tarefa. |
| `USERS` | `50` | Usuários cadastrados antes do teste. |
| `AUTH_SCHEME` | `Bearer` | Prefixo do header `Authorization`. `none` manda o token puro. |
| `AO_VIVO` | vazio | `1` liga também o painel do próprio k6 em http://localhost:5665. |

No Linux e no macOS dá para mudar uma variável só numa execução: `RATE=200 ./run.sh capacidade`.

O painel usa as portas 3030 (Grafana) e 8086 (InfluxDB), as duas só nesta máquina. O histórico fica num volume do Docker; para apagar tudo, rode `docker compose down -v`.

## Como funciona

- `run.sh` e `run.bat` sobem o painel, medem a memória e a CPU da API em segundo plano (`scripts/medir.sh` e `scripts/medir.ps1`, que acham a API pela porta) e rodam o k6 no container oficial (`compose.yaml` e `docker/entrypoint.sh`).
- Durante o teste, o k6 e o medidor gravam as métricas no InfluxDB, e o Grafana desenha o painel a partir delas (`grafana/`).
- `k6/contract.js` é o checklist; `k6/load.js` é o teste de carga; `k6/report.js` monta o resumo e o relatório HTML e grava a linha da execução no painel; `k6/compare.js` compara dois resultados.
- O teste de carga usa modelo aberto: o k6 manda requisições numa taxa fixa, mesmo que a API esteja lenta. Assim as duas APIs recebem exatamente a mesma carga.
- Mix de tráfego: 60% listar, 30% criar, editar e apagar a mesma tarefa, 8% login e 2% cadastro.
- Com o k6 instalado, dá para rodar sem Docker, de dentro da pasta: `k6 run -e BASE_URL=http://localhost:3000 -e PROFILE=dev k6/load.js` (sem painel, memória e CPU).
