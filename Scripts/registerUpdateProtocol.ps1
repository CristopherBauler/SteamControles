# Registra steamwish:// para o botao Atualizar do Obsidian.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bat = Join-Path $PSScriptRoot "protocolUpdate.bat"
$proto = "steamwish"

New-Item -Path "HKCU:\Software\Classes\$proto" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$proto" -Name "(default)" -Value "URL:Steam Wishlist Update"
New-ItemProperty -Path "HKCU:\Software\Classes\$proto" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null

$cmdKey = "HKCU:\Software\Classes\$proto\shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name "(default)" -Value "`"$bat`" `"%1`""

Write-Host "Atalho steamwish://update registrado."
Write-Host "No Obsidian, o botao Atualizar abre o script sem precisar do servidor local."
