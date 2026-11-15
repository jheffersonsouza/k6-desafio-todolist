# Mede memória (MB) e CPU (núcleos) da API a cada segundo, enquanto o arquivo-sinal existir. Chamado pelo run.ps1.
# Acha a API pela porta: primeiro um container que publique a porta, depois um processo escutando nela.
# Cada amostra vai para o CSV (relatório) e para o painel (InfluxDB), se ele estiver de pé.
param([string] $Url, [string] $Out, [string] $Flag, [string] $Api, [string] $Run, [string] $Label)

$invariant = [Globalization.CultureInfo]::InvariantCulture
# Tag do InfluxDB: espaço, vírgula e sinal de igual escapados.
$labelTag = $Label -replace '([ ,=])', '\$1'
$uri = [Uri] $Url
# Só dá para medir a API se ela estiver nesta máquina.
if (@('localhost', '127.0.0.1', 'host.docker.internal', '0.0.0.0') -notcontains $uri.Host) { return }
$port = $uri.Port

function Get-Now {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
}

function Write-Sample([double] $Time, [double] $Memory, $Cores) {
  $cpu = ''
  if ($null -ne $Cores) { $cpu = ([double] $Cores).ToString('0.00', $invariant) }
  $memoryText = $Memory.ToString('0.0', $invariant)
  Add-Content -Path $Out -Value ('{0},{1},{2}' -f $Time.ToString('0.000', $invariant), $memoryText, $cpu) -Encoding Ascii
  $fields = "memoria_mb=$memoryText"
  if ($cpu) { $fields += ",cpu_nucleos=$cpu" }
  $body = 'api_recursos,api={0},run={1},rotulo={2} {3} {4}' -f $Api, $Run, $labelTag, $fields, [long]($Time * 1000)
  try {
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8086/write?db=k6&precision=ms' -Body $body -TimeoutSec 2 | Out-Null
  } catch {
    # Sem o painel no ar, a amostra fica só no CSV.
  }
}

$container = docker ps --filter "publish=$port" --format '{{.Names}}' 2>$null | Select-Object -First 1
if ($container) {
  Set-Content -Path $Out -Value "# container $container" -Encoding Ascii
  $factors = @{ 'B' = 1.0 / 1MB; 'kB' = 1.0 / 1KB; 'KiB' = 1.0 / 1KB; 'MB' = 1.0; 'MiB' = 1.0; 'GB' = 1024.0; 'GiB' = 1024.0 }
  while (Test-Path $Flag) {
    $stats = docker stats --no-stream --format '{{.MemUsage}};{{.CPUPerc}}' $container 2>$null | Select-Object -First 1
    if (-not $stats) { break }
    # Ex.: "45.3MiB / 15.5GiB;12.34%"
    $memory, $cpu = $stats.Split(';')
    if ($memory.Split('/')[0].Trim() -match '^([\d.]+)\s*([A-Za-z]+)$' -and $factors.ContainsKey($Matches[2])) {
      $megabytes = [double]::Parse($Matches[1], $invariant) * $factors[$Matches[2]]
      $cores = [double]::Parse($cpu.Trim().TrimEnd('%'), $invariant) / 100
      Write-Sample (Get-Now) $megabytes $cores
    }
  }
  return
}

$connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $connection) { return }
$processId = $connection.OwningProcess
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $process) { return }
Set-Content -Path $Out -Value "# processo $($process.ProcessName) (PID $processId)" -Encoding Ascii

# Memória: working set do processo. CPU: diferença do tempo de CPU entre uma amostra e a anterior.
$previous = $null
while (Test-Path $Flag) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { break }
  $now = Get-Now
  $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
  if ($previous) { Write-Sample $now ($process.WorkingSet64 / 1MB) (($cpuSeconds - $previous[1]) / ($now - $previous[0])) }
  $previous = @($now, $cpuSeconds)
  Start-Sleep -Seconds 1
}
