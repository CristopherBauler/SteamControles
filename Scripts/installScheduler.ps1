# Cria (ou atualiza) a tarefa diária no Agendador do Windows.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $root "config.json"

if (-not (Test-Path $configPath)) {
    throw "config.json nao encontrado em $root"
}

$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hour = if ($config.updateHour) { $config.updateHour } else { "08:00" }
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $root "Scripts\updateWishlist.js"
$taskName = "SteamWishlistDashboard"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --daily" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $hour
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Atualiza a wishlist Steam do Obsidian 1x ao dia" -Force | Out-Null

& (Join-Path $PSScriptRoot "registerUpdateProtocol.ps1")

Write-Host "Tarefa '$taskName' agendada para todo dia as $hour"
