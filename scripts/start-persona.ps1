param(
    [string]$WorkspaceRoot = '',
    [string]$DshDirectory = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$NapCatRoot = (Join-Path $env:USERPROFILE 'Downloads\NapCat.Framework'),
    [switch]$CheckOnly,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $WorkspaceRoot) {
    $pluginDirectory = Split-Path -Parent $PSScriptRoot
    $WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $pluginDirectory)
}
$astrDirectory = Join-Path $WorkspaceRoot 'apps\AstrBot'
$pythonExecutable = Join-Path $astrDirectory '.venv\Scripts\python.exe'
$dshShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'
$napLoaderPath = Join-Path $NapCatRoot 'napiLoader.bat'
$launcherLogs = Join-Path $DshDirectory 'qq-bridge\launcher'

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $Port)
        return ($connection.Wait(350) -and $client.Connected)
    } catch { return $false } finally { $client.Dispose() }
}

function Read-PersonaHealth {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3188/health' -TimeoutSec 2
        if ($health.ok -and $health.plugin -eq 'dsh-qq-persona') { return $health }
    } catch { }
    return $null
}

function Read-OnlineState {
    try {
        $secretFile = Join-Path $DshDirectory 'qq-bridge\secrets.json'
        $privateConfig = Get-Content -LiteralPath $secretFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $headers = @{}
        if ($privateConfig.napcat_http_token) { $headers.Authorization = 'Bearer ' + $privateConfig.napcat_http_token }
        $reply = Invoke-RestMethod -Uri 'http://127.0.0.1:5700/get_status' -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 2
        if ($reply.status -eq 'ok' -and $reply.data.online -eq $true) { return 'QQ 已在线' }
        return 'QQ 尚未在线，请检查登录'
    } catch { return '登录状态未确认，请打开 NapCat 检查' }
}

function Get-BridgeState {
    $health = Read-PersonaHealth
    $astr = Test-LocalPort 6185
    $onebot = Test-LocalPort 6199
    $onebotConnected = $null
    try {
        $onebotConnected = @(Get-NetTCPConnection -LocalPort 6199 -State Established -ErrorAction Stop).Count -gt 0
    } catch { }
    $nap = Test-LocalPort 6099
    $personaText = '未就绪'
    $compactText = '等待插件就绪'
    if ($health) {
        $personaText = '已就绪'
        if ($health.version) { $personaText += ' (' + $health.version + ')' }
        if ($health.capabilities -notcontains 'native-auto-compact') { $compactText = '更新待加载，请从应用菜单重启 DSH' }
        elseif (-not $health.contextMaintenance.enabled) { $compactText = '自动压缩已关闭' }
        elseif (-not $health.contextMaintenance.nativeServiceAvailable) { $compactText = '原生压缩服务尚未就绪' }
        elseif ($health.contextMaintenance.status -in @('native-command-unavailable', 'native-compact-failed', 'maintenance-failed', 'recovery-not-saved', 'memory-db-unavailable')) { $compactText = '上次整理未成功，已保留当前历史' }
        elseif ($health.contextMaintenance.status -eq 'ok') { $compactText = '原生压缩已成功执行' }
        else { $compactText = '已启用，达到预算后整理；等待首次运行验证' }
    }
    return [pscustomobject]@{
        checkedAt = (Get-Date).ToString('s')
        persona = $personaText
        astrbot = $(if ($astr -and $onebotConnected) { '管理端与 OneBot 连接已就绪' } elseif ($astr -and $onebot) { '已监听，NapCat 连接尚未确认' } elseif ($astr) { '管理端已启动，OneBot 尚未就绪' } else { '未启动' })
        napcat = $(if ($nap) { '管理端已启动' } else { '未启动' })
        qq = $(if ($nap) { Read-OnlineState } else { '等待 NapCat 启动' })
        compaction = $compactText
        ports = [pscustomobject]@{ persona = [bool]$health; astrbot = $astr; onebot = $onebot; onebotConnected = $onebotConnected; napcat = $nap }
    }
}

# 只读检查是可脚本化的：不创建进程、快捷方式、日志或任何业务消息。
if ($CheckOnly) {
    $currentState = Get-BridgeState
    if ($Json) { $currentState | ConvertTo-Json -Depth 4 } else { $currentState | Format-List }
    exit 0
}

function Write-StartupPhase([string]$Phase) {
    try {
        [void][System.IO.Directory]::CreateDirectory($launcherLogs)
        [System.IO.File]::AppendAllText((Join-Path $launcherLogs 'startup.log'), ((Get-Date).ToString('s') + ' ' + $Phase + [Environment]::NewLine), [System.Text.Encoding]::UTF8)
    } catch { }
}
trap {
    Write-StartupPhase ('failed line=' + $_.InvocationInfo.ScriptLineNumber + ' type=' + $_.Exception.GetType().FullName + ' message=' + $_.Exception.Message)
    exit 1
}
Write-StartupPhase 'initializing-forms'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Write-StartupPhase 'creating-mutex'
$launcherAccountSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$launchMutex = New-Object System.Threading.Mutex($false, ('Local\DshQqPersonaLauncher-' + $launcherAccountSid))
if (-not $launchMutex.WaitOne(0)) {
    Write-StartupPhase 'launcher-already-running'
    [System.Windows.Forms.MessageBox]::Show('启动检查已经在运行，请查看已打开的窗口。', 'QQ 伙伴') | Out-Null
    $launchMutex.Dispose()
    exit 0
}

Write-StartupPhase 'creating-window'
$window = New-Object System.Windows.Forms.Form
$window.Text = 'QQ 伙伴 · 启动与状态'
$window.Size = New-Object System.Drawing.Size(660, 420)
$window.StartPosition = 'CenterScreen'
$window.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$window.FormBorderStyle = 'FixedDialog'
$window.MaximizeBox = $false
$statusBox = New-Object System.Windows.Forms.TextBox
$statusBox.Multiline = $true
$statusBox.ReadOnly = $true
$statusBox.ScrollBars = 'Vertical'
$statusBox.Location = New-Object System.Drawing.Point(18, 18)
$statusBox.Size = New-Object System.Drawing.Size(606, 270)
$statusBox.BackColor = [System.Drawing.Color]::White
$window.Controls.Add($statusBox)
$retryButton = New-Object System.Windows.Forms.Button
$retryButton.Text = '检查并启动'
$retryButton.Location = New-Object System.Drawing.Point(18, 306)
$retryButton.Size = New-Object System.Drawing.Size(150, 36)
$window.Controls.Add($retryButton)
$loginButton = New-Object System.Windows.Forms.Button
$loginButton.Text = '打开 QQ 登录'
$loginButton.Location = New-Object System.Drawing.Point(184, 306)
$loginButton.Size = New-Object System.Drawing.Size(150, 36)
$loginButton.Add_Click({ Start-Process -FilePath 'http://127.0.0.1:6099/webui' })
$window.Controls.Add($loginButton)
$logsButton = New-Object System.Windows.Forms.Button
$logsButton.Text = '打开启动日志'
$logsButton.Location = New-Object System.Drawing.Point(350, 306)
$logsButton.Size = New-Object System.Drawing.Size(150, 36)
$logsButton.Add_Click({ if (Test-Path -LiteralPath $launcherLogs) { Start-Process -FilePath 'explorer.exe' -ArgumentList @($launcherLogs) } })
$window.Controls.Add($logsButton)

function Show-Progress([string]$Text) {
    Write-StartupPhase $Text
    $statusBox.AppendText($Text + [Environment]::NewLine)
    [System.Windows.Forms.Application]::DoEvents()
}

function Wait-ForPort([int]$Port, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-LocalPort $Port) { return $true }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-MissingServices {
    $retryButton.Enabled = $false
    $window.ControlBox = $false
    $statusBox.Clear()
    try {
        Show-Progress '正在检查已有服务，已运行的服务会直接复用。'
        if (-not (Read-PersonaHealth)) {
            if ((Test-LocalPort 3188) -or (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
                Show-Progress 'DSH 已在运行，但插件未就绪。请从 DSH 应用菜单重启或检查插件配置。'
            } elseif (Test-Path -LiteralPath $dshShortcutPath) {
                Show-Progress '正在启动 DSH…'
                Start-Process -FilePath $dshShortcutPath -WindowStyle Hidden | Out-Null
                [void](Wait-ForPort 3188 45)
            } else { Show-Progress '找不到 DeepSeek Harness 桌面快捷方式，请先打开 DSH。' }
        }
        if (-not (Test-LocalPort 6185)) {
            $runningPython = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $pythonExecutable }
            if ($runningPython) { Show-Progress 'AstrBot 进程已存在，正在等待管理端就绪。' }
            elseif (Test-Path -LiteralPath $pythonExecutable) {
                New-Item -ItemType Directory -Path $launcherLogs -Force | Out-Null
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                Show-Progress '正在独立启动 AstrBot…'
                $oldEncoding = $env:PYTHONIOENCODING
                $oldBuffering = $env:PYTHONUNBUFFERED
                try {
                    $env:PYTHONIOENCODING = 'utf-8'
                    $env:PYTHONUNBUFFERED = '1'
                    Start-Process -FilePath $pythonExecutable -ArgumentList @('main.py') -WorkingDirectory $astrDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $launcherLogs ("astrbot-$stamp.out.log")) -RedirectStandardError (Join-Path $launcherLogs ("astrbot-$stamp.err.log")) | Out-Null
                } finally { $env:PYTHONIOENCODING = $oldEncoding; $env:PYTHONUNBUFFERED = $oldBuffering }
            } else { Show-Progress '找不到 AstrBot 的 Python 环境，请检查安装目录。' }
            [void](Wait-ForPort 6185 45)
        }
        if (-not (Test-LocalPort 6099)) {
            if (Get-Process -Name 'napimain' -ErrorAction SilentlyContinue) { Show-Progress 'NapCat 启动进程已存在，请检查 QQ 登录窗口。' }
            elseif (Test-Path -LiteralPath $napLoaderPath) {
                Show-Progress '正在启动 NapCat。若 QQ 要求扫码，请完成登录。'
                Start-Process -FilePath $napLoaderPath -WorkingDirectory $NapCatRoot -WindowStyle Hidden | Out-Null
                [void](Wait-ForPort 6099 30)
            } else { Show-Progress '找不到 NapCat 启动文件，请检查安装目录。' }
        }
        $currentState = Get-BridgeState
        $statusBox.Clear()
        Show-Progress ('DSH 人格：' + $currentState.persona)
        Show-Progress ('AstrBot：' + $currentState.astrbot)
        Show-Progress ('NapCat：' + $currentState.napcat)
        Show-Progress ('QQ：' + $currentState.qq)
        Show-Progress ('上下文整理：' + $currentState.compaction)
        Show-Progress ''
        Show-Progress '关闭此状态窗口后，已启动的服务继续运行。'
        Show-Progress '重启 DSH 后，可再点一次桌面快捷方式检查链路。'
    } catch {
        Write-StartupPhase ('services-failed line=' + $_.InvocationInfo.ScriptLineNumber + ' type=' + $_.Exception.GetType().FullName + ' message=' + $_.Exception.Message)
        Show-Progress '启动未完成。请检查安装目录或使用下方按钮打开启动日志。'
    } finally { $retryButton.Enabled = $true; $window.ControlBox = $true }
}

$retryButton.Add_Click({ Start-MissingServices })
$window.Add_Shown({ Start-MissingServices })
Write-StartupPhase 'showing-window'
try { [void]$window.ShowDialog() } finally {
    Write-StartupPhase 'window-closed'
    $window.Dispose()
    $launchMutex.ReleaseMutex()
    $launchMutex.Dispose()
}
