# k6-desafio-todolist

Testes de contrato e de carga, feitos com [k6](https://grafana.com/docs/k6/latest/), para o desafio [Todo List API do roadmap.sh](https://roadmap.sh/projects/todo-list-api).

> Este repositório foi gerado inteiramente com IA (Claude Code). A ideia é usar a mesma suite para testar as duas implementações do desafio, uma em Java e outra em C#. Os testes só falam HTTP com a API, então servem para qualquer linguagem que siga a spec.

## Jeito rápido

Só precisa de Docker (no Windows e no macOS, o Docker Desktop).

1. Clone o repositório:

   ```bash
   git clone https://github.com/jheffersonsouza/k6-desafio-todolist.git
   cd k6-desafio-todolist
   ```

2. Copie `.env.example` para `.env` e ajuste `API` (seu nome nos relatórios) e a porta da `BASE_URL`.
3. Suba a sua API.
4. Rode:

   ```bash
   docker compose run --rm --service-ports k6 load
   ```

5. Abra http://localhost:5665 para acompanhar os gráficos ao vivo. No fim, o relatório fica em `results/`: um `.html` com os gráficos, um `.json` e um `.md`.

Antes de qualquer teste de carga, o `run.sh` roda o teste de contrato. Se a API não seguir a spec, ele para e mostra o que falhou.

| comando | o que faz |
| --- | --- |
| `docker compose run --rm k6 contract` | Só o teste de contrato. |
| `docker compose run --rm k6 smoke` | Contrato e carga mínima, para ver se está tudo funcionando. |
| `docker compose run --rm --service-ports k6 load` | Contrato e perfil `load`. Troque por `stress`, `spike`, `soak` ou `breakpoint`. |
| `docker compose run --rm k6 compare results/<a>.json results/<b>.json` | Compara dois resultados. |

O `--service-ports` publica a porta 5665 do dashboard. Para mudar uma variável só numa execução, use `-e`: `docker compose run --rm --service-ports -e RATE=200 k6 stress`.

Se o k6 não conseguir conectar: no Linux, a API precisa escutar em `0.0.0.0`, não só em `localhost`. O Spring já faz isso. No ASP.NET, rode com `--urls http://0.0.0.0:<porta>`.

## Java x C#: comparação justa

Resultados de PCs diferentes não se comparam, porque hardware diferente dá número diferente. Cada um pode usar a suite no próprio PC para acompanhar a evolução da sua API. Já o duelo precisa das duas APIs rodando na mesma máquina, uma de cada vez. Por exemplo, um de vocês clona a API do outro e roda as duas.

O ambiente e a configuração pesam mais no resultado do que a linguagem. Antes da rodada que vale, combinem:

- **Uma API por vez**, sem nada pesado rodando junto. Se o k6 roda na mesma máquina, limitem a API, ex.: `docker run --cpus=2 --memory=1g`.
- **Mesmo banco**, de preferência o mesmo PostgreSQL em Docker, zerado antes de cada rodada. O teste cria usuários e todos novos a cada execução.
- **Mesmo hash de senha, com o mesmo custo.** Ele domina o tempo de login e cadastro. `new BCryptPasswordEncoder()` usa custo 10, mas `BCrypt.Net.BCrypt.HashPassword` usa 11 por padrão (o dobro do trabalho). O ASP.NET Identity usa PBKDF2, que é outro algoritmo.
- **Mesmo tamanho de pool de conexões.** O HikariCP vem com 10, o Npgsql com 100.
- **Build de produção**: `dotnet run -c Release` (ou `publish`) e `java -jar` do jar empacotado, sem devtools.
- **Log em nível INFO**, sem log por requisição e sem SQL no console (`spring.jpa.show-sql=false`, EF Core em `Warning`).
- **Aquecimento.** JVM e .NET compilam o código quente durante a execução (JIT). Rodem um `load` curto (`-e DURATION=1m`) e descartem antes da rodada oficial.
- **Validade do token maior que o teste.** O soak dura 33 minutos.
- **Rate limiting desligado** (é bônus da spec). Ligado, o teste mede o rate limiter.
- **Mesmos parâmetros**: perfil, `RATE`, `DURATION` e `SCENARIOS`. O `compare` avisa quando são diferentes.

No `breakpoint`, login e cadastro costumam quebrar primeiro por causa do hash. Para achar o limite do CRUD, rodem também com `-e SCENARIOS=browse,write`.

## O que a API precisa seguir

| rota | sucesso | erro |
| --- | --- | --- |
| `POST /register` `{ name, email, password }` | 200/201 `{ token }` | 4xx para e-mail repetido ou dados faltando |
| `POST /login` `{ email, password }` | 200 `{ token }` | 4xx para credenciais erradas |
| `POST /todos` `{ title, description }` | 200/201 `{ id, title, description }` | 401 sem token, 4xx sem `title` |
| `PUT /todos/{id}` `{ title, description }` | 200 `{ id, title, description }` | 401 sem token, 403 se não for o dono |
| `DELETE /todos/{id}` | 204 | 401 sem token, 4xx se não for o dono |
| `GET /todos?page=1&limit=10` | 200 `{ data, page, limit, total }` | 401 sem token |

O token vai em `Authorization: Bearer <token>`, que é o padrão do Spring Security e do ASP.NET. A spec fala em mandar o token puro no header. Se for o caso, use `AUTH_SCHEME=none`. O importante é vocês dois usarem o mesmo formato.

No teste de contrato, `[MUST]` é exigido pela spec e reprova o teste. `[SHOULD]` é boa prática que a spec não define, por exemplo 409 para e-mail repetido ou 404 para id inexistente. Aparece no resumo, mas não reprova.

## Configuração

Tudo pelo `.env`, ou com `-e` numa execução só.

| variável | padrão | uso |
| --- | --- | --- |
| `BASE_URL` | `http://host.docker.internal:8080` | Endereço da API visto de dentro do container. |
| `API` | `api` | Nome que vai no relatório (`java`, `csharp`...). |
| `RATE` | `100` | Iterações por segundo no patamar 1x, somando todos os cenários. |
| `DURATION` | do perfil | Troca a duração do patamar principal, ex.: `10m`. |
| `SCENARIOS` | `browse,write,auth,signup` | Quais cenários rodar. A taxa é dividida só entre eles. |
| `USERS` | 5 no smoke, 50 nos outros | Usuários criados antes do teste. |
| `AUTH_SCHEME` | `Bearer` | Prefixo do header `Authorization`. `none` manda o token puro. |
| `SKIP_CONTRACT` | vazio | `1` pula o teste de contrato antes da carga. |

### Perfis

| perfil | carga | duração |
| --- | --- | --- |
| `smoke` | 1 VU por cenário, 3 a 5 iterações cada | segundos |
| `load` | sobe até 1x `RATE` e mantém por 5 min | 6m30s |
| `stress` | sobe até 2x `RATE` e mantém por 5 min | 8m |
| `spike` | 0,5x, pico de 5x por 1 min, volta para 0,5x | 3m |
| `soak` | 1x `RATE` por 30 min. Pega vazamento de memória e de conexões. | 33m |
| `breakpoint` | sobe sem parar até 20x `RATE` e para quando estoura um threshold | até 10m |

Todos os perfis, menos o smoke, usam modelo aberto (`ramping-arrival-rate`). O k6 inicia iterações na taxa configurada mesmo que a API esteja lenta, então as duas APIs recebem exatamente a mesma carga.

### Cenários

| cenário | fatia de `RATE` | o que cada iteração faz |
| --- | --- | --- |
| `browse` | 60% | `GET /todos` numa página aleatória |
| `write` | 30% | `POST /todos`, `PUT` e `DELETE` do mesmo todo |
| `auth` | 8% | `POST /login` |
| `signup` | 2% | `POST /register` |

Antes de começar, o teste cadastra `USERS` usuários e cria 25 todos para cada um (3 páginas de 10). Com o mix completo, `RATE=100` dá uns 160 req/s.

### Thresholds

O teste de carga reprova (exit code 99) se acontecer qualquer um destes:

- mais de 1% de erro, no geral ou em alguma rota;
- menos de 99% dos checks passando;
- p95 acima de 300 ms na listagem, 500 ms em create/update/delete ou 1 s em login/cadastro.

Os limites estão em `SLO_P95_MS`, no `load.js`. No perfil `breakpoint`, estourar um deles encerra o teste, e o relatório mostra a carga em que isso aconteceu.

## Lendo os resultados

- Compare principalmente p95, p99 e erros. No modelo aberto o req/s é o mesmo nas duas APIs enquanto elas aguentam a carga.
- Quando uma API não aguenta, aparecem iterações descartadas (o k6 ficou sem VU livre porque as respostas demoravam) e erros.
- No `breakpoint`, a linha "ruptura" diz quantas req/s o k6 gerava quando o teste parou. O threshold usa o p95 acumulado desde o início, então a degradação real começa um pouco antes. Os gráficos do HTML mostram o ponto exato.
- O `.html` não depende de nada, dá para mandar para o outro abrir no navegador.

## Sem Docker

Com o [k6 instalado](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`brew install k6`, `winget install k6 --source winget`...), aqui `localhost` funciona direto:

```bash
k6 run -e BASE_URL=http://localhost:8080 contract.js
k6 run -e BASE_URL=http://localhost:8080 -e API=java -e PROFILE=load load.js
k6 run -q -e A=results/<a>.json -e B=results/<b>.json compare.js
```

No Linux e no macOS, `BASE_URL=http://localhost:8080 API=java sh run.sh load` faz o mesmo que o compose, com dashboard e tudo.

## Arquivos

| arquivo | o que faz |
| --- | --- |
| `compose.yaml`, `run.sh` | Rodam tudo no container oficial do k6, sem instalar nada. |
| `contract.js` | Confere se a API segue a spec: status, formato das respostas, 401/403 e paginação. |
| `load.js` | Teste de carga, com os perfis acima. |
| `compare.js` | Compara dois resultados lado a lado. |
| `lib/` | Cliente HTTP, dados aleatórios, perfis de carga e relatório. |
| `results/` | Relatórios gerados (`<api>_<perfil>_<data>.html`, `.json` e `.md`). |
