# Roda os testes com Docker no Windows; o run.bat chama este script. Faz o mesmo que o run.sh.
# Os gráficos ficam no painel: http://localhost:3030
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host 'Criei o .env a partir do .env.example. Confira API e BASE_URL.'
}

# Valor de uma variável: do ambiente, se tiver, senão do .env.
function Get-Setting([string] $Name, [string] $Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value) {
    $line = Get-Content '.env' | Where-Object { $_ -like "$Name=*" } | Select-Object -Last 1
    if ($line) { $value = $line.Substring($Name.Length + 1).Trim() }
  }
  if ($value) { return $value }
  return $Default
}

# Sobe o painel (Grafana e InfluxDB) se ainda não estiver de pé. Na primeira vez baixa as imagens.
function Start-Panel {
  Write-Host 'Subindo o painel (na primeira vez baixa as imagens, pode demorar)...'
  $log = docker compose up -d --quiet-pull grafana 2>&1
  if ($LASTEXITCODE -ne 0) {
    $log | Write-Host
    exit 1
  }
}

$offset = (Get-Date).ToString('zzz').Replace(':', '')
$command = 'dev'
if ($args.Count -gt 0) { $command = $args[0] }

if ($command -eq 'painel') {
  Start-Panel
  Write-Host 'Painel: http://localhost:3030'
  Start-Process 'http://localhost:3030'
  exit 0
}
if ($command -eq 'parar') {
  # Para só o teste; o painel continua no ar.
  $ids = docker ps -q --filter label=com.docker.compose.project=k6-desafio-todolist --filter label=com.docker.compose.service=k6
  foreach ($id in $ids) { docker stop $id | Out-Null }
  exit 0
}
if ($command -eq 'desligar') {
  docker compose down
  exit $LASTEXITCODE
}
if (@('dev', 'capacidade', 'resistencia') -notcontains $command) {
  docker compose run --rm --no-deps -e "UTC_OFFSET=$offset" k6 @args
  exit $LASTEXITCODE
}

$api = (Get-Setting 'API' 'api') -replace '[^A-Za-z0-9_.-]', '_'
$stamp = (Get-Date).ToString('yyyy-MM-dd-HH-mm-ss')
$name = '{0}_{1}_{2}' -f $api, $command, $stamp
$kind = @{ 'dev' = 'rápido'; 'capacidade' = 'capacidade'; 'resistencia' = 'resistência' }[$command]
$label = '{0} · {1} · {2}' -f $api, $kind, (Get-Date).ToString('dd/MM HH:mm')
$results = Join-Path (Get-Location) 'results'
$flag = Join-Path $results ".medindo-$name"
$csv = Join-Path $results "$name.recursos.csv"

Start-Panel

# Mede memória e CPU da API em segundo plano enquanto o teste roda.
New-Item -ItemType File -Path $flag -Force | Out-Null
$url = Get-Setting 'BASE_URL' 'http://host.docker.internal:8080'
$sampler = Start-Job -FilePath (Join-Path $PSScriptRoot 'medir.ps1') -ArgumentList $url, $csv, $flag, $api, $name, $label

$status = 0
try {
  docker compose run --rm --no-deps --service-ports --name "k6-$name" -e "API=$api" -e "RUN_NAME=$name" -e "RUN_LABEL=$label" k6 $command
  $status = $LASTEXITCODE
} finally {
  # Com Ctrl+C o PowerShell chega aqui antes do k6 terminar de salvar o resultado: espera o container sair.
  docker wait "k6-$name" 2>&1 | Out-Null
  Remove-Item $flag -Force -ErrorAction SilentlyContinue
  $sampler | Wait-Job -Timeout 15 | Out-Null
  $sampler | Remove-Job -Force
  if (Test-Path (Join-Path $results "$name.json")) {
    docker compose run --rm --no-deps -e "UTC_OFFSET=$offset" -e "RUN_LABEL=$label" k6 relatorio $name
  }
  Remove-Item $csv -Force -ErrorAction SilentlyContinue
}
exit $status
