param(
    [string]$DesktopDirectory = ([Environment]::GetFolderPath('Desktop')),
    [string]$LauncherPath = (Join-Path $PSScriptRoot 'start-persona.ps1')
)
$ErrorActionPreference = 'Stop'
$launcherFile = (Resolve-Path -LiteralPath $LauncherPath).Path
if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop directory does not exist.' }
$shortcutPath = Join-Path $DesktopDirectory 'QQ 伙伴启动.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Copy-Item -LiteralPath $shortcutPath -Destination ($shortcutPath + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherFile + '"'
$shortcut.WorkingDirectory = Split-Path -Parent $launcherFile
$shortcut.Description = '检查并启动 QQ 伙伴所需的 DSH、AstrBot 与 NapCat'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',23'
$shortcut.Save()
Write-Output $shortcutPath
