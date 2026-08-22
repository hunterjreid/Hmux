# mux installer.
#
#   irm https://raw.githubusercontent.com/hunterjreid/mux/master/install.ps1 | iex
#
# Fetches the latest release, drops the two binaries in %LOCALAPPDATA%\mux,
# puts that directory on PATH and adds a Start menu entry. Run it again later
# and it updates in place.
#
# Deliberately the portable binaries rather than the NSIS installer. Fetching
# them with PowerShell does not mark them as web downloads, so an unsigned
# build starts without a SmartScreen prompt, and uninstalling is deleting a
# folder. The installer stays on the releases page for anyone who wants one.
#
# Nothing here needs administrator rights: everything is per-user.

param(
    # Install what is in target\release rather than the latest release. This is
    # the loop for working on mux itself: `cargo build --release --workspace`,
    # then this, and the copy you actually run is the one you just built.
    [switch] $FromBuild
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 still negotiates TLS 1.0 by default, which github.com refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo       = 'hunterjreid/mux'
$InstallDir = Join-Path $env:LOCALAPPDATA 'mux'
# mux-daemon is not optional. It owns the terminals; the two front ends are
# views onto it. An install without it is a window that cannot open a shell,
# and it fails at the point you click New rather than at startup, so it does
# not look like a missing file - it looks like the app is broken.
$Binaries   = @('mux-gui.exe', 'mux.exe', 'mux-daemon.exe')

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) {
    Write-Host ''
    Write-Host "  install failed: $text" -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  mux' -ForegroundColor Cyan
Write-Host '  terminals that keep running whether or not you are looking at them' -ForegroundColor DarkGray
Write-Host ''

# ---- what this machine can run -------------------------------------------

# ConPTY arrives in Windows 10 1809. Without it there is no pseudoconsole to
# put a shell in, so there is no point installing anything.
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) {
    Fail "mux needs Windows 10 1809 or newer, and this is build $build."
}

# Overwriting a running executable fails part way through and leaves a file
# that is neither the old build nor the new one.
#
# The two front ends have to be closed. The daemon deliberately does not: it is
# holding every terminal you have open, and an update that made you kill your
# shells to install it would cost you the thing the daemon exists to protect.
# Windows refuses to overwrite a running image but is perfectly happy to rename
# one, so the running daemon is moved aside and keeps executing from the moved
# file. The new binary takes its place and is what starts next time — which is
# whenever the old one exits, having been idle for two minutes with nothing
# left to hold.
$running = Get-Process -Name 'mux-gui', 'mux' -ErrorAction SilentlyContinue
if ($running) {
    Fail 'mux is already running. Close it, then run this again.'
}

# Sweep up anything moved aside by a previous run. These are only removable
# once the process using them has exited, so a failure here is expected and
# means the old daemon is still going.
Get-ChildItem -Path $InstallDir -Filter '*.old' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

$daemonRunning = [bool] (Get-Process -Name 'mux-daemon' -ErrorAction SilentlyContinue)
if ($daemonRunning) {
    $live = Join-Path $InstallDir 'mux-daemon.exe'
    if (Test-Path $live) {
        # A unique name every time, rather than a fixed `.old`.
        #
        # The sweep above cannot delete a file the previous daemon is still
        # executing, so on a second update the fixed name is still there and
        # still locked — and `Move-Item -Force` cannot overwrite a file that is
        # in use, so the install failed on its own leftovers. A name nothing
        # else can be holding never collides.
        $aside = "$live.$(Get-Random).old"
        try {
            Move-Item -Path $live -Destination $aside
            Write-Step 'moved the running daemon aside; your terminals keep running'
        } catch {
            Fail "could not move the running daemon aside: $($_.Exception.Message)"
        }
    }
}

# The GUI is a WebView2 host. Windows 11 ships the runtime; some Windows 10
# machines do not have it, and without it the window opens empty with no
# explanation of why.
$webviewKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$hasWebView = $false
foreach ($key in $webviewKeys) {
    try {
        $pv = (Get-ItemProperty -Path $key -Name pv -ErrorAction Stop).pv
        if ($pv -and $pv -ne '0.0.0.0') { $hasWebView = $true; break }
    } catch { }
}

# ---- get the binaries ------------------------------------------------------

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

if ($FromBuild) {
    # $PSScriptRoot is the repository root, since this file lives there.
    $buildDir = Join-Path $PSScriptRoot 'target\release'
    if (-not (Test-Path $buildDir)) {
        Fail "no build at $buildDir. Run: cargo build --release --workspace"
    }

    foreach ($name in $Binaries) {
        $source = Join-Path $buildDir $name
        if (-not (Test-Path $source)) {
            Fail "$name is not built. Run: cargo build --release --workspace"
        }
        Write-Step "copying $name"
        Copy-Item -Path $source -Destination (Join-Path $InstallDir $name) -Force
    }
    $tag = 'your local build'
} else {
    Write-Step 'looking up the latest release'
    try {
        $release = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$Repo/releases/latest" `
            -Headers @{ 'User-Agent' = 'mux-install' }
    } catch {
        Fail "could not reach GitHub: $($_.Exception.Message)"
    }

    $tag = $release.tag_name
    if (-not $tag) { Fail "no published release yet at github.com/$Repo/releases" }
    Write-Step "found $tag"

    foreach ($name in $Binaries) {
        $asset = $release.assets | Where-Object { $_.name -eq $name }
        if (-not $asset) { Fail "release $tag has no $name" }

        $target = Join-Path $InstallDir $name
        # To a temporary name first, so a download that dies part way through
        # cannot replace a working copy with half a file.
        $partial = "$target.partial"
        Write-Step "downloading $name"
        try {
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $partial -UseBasicParsing
            Move-Item -Path $partial -Destination $target -Force
        } catch {
            Remove-Item $partial -ErrorAction SilentlyContinue
            Fail "could not download ${name}: $($_.Exception.Message)"
        }
    }
}

# ---- put it within reach ---------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = $userPath.Split(';') | Where-Object { $_ } }

if ($entries -notcontains $InstallDir) {
    Write-Step 'adding it to your PATH'
    $updated = (@($entries) + $InstallDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
}
# So `mux` works in this session too, not just the next one.
if (($env:Path -split ';') -notcontains $InstallDir) {
    $env:Path = "$env:Path;$InstallDir"
}

try {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut(
        (Join-Path $startMenu 'mux.lnk'))
    $shortcut.TargetPath = Join-Path $InstallDir 'mux-gui.exe'
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.Description = 'mux — terminals and a browser in one window'
    $shortcut.Save()
    Write-Step 'added a Start menu entry'
} catch {
    # A missing shortcut is not worth failing an otherwise good install over.
    Write-Step 'could not add a Start menu entry, which is not fatal'
}

# ---- what to do next -------------------------------------------------------

Write-Host ''
Write-Host "  installed $tag to $InstallDir" -ForegroundColor Green
Write-Host ''
Write-Host '    mux-gui     the window: terminals, status lights and a browser'
Write-Host '    mux         the console version, inside the terminal you are in'
Write-Host ''

if (-not $hasWebView) {
    Write-Host '  one more thing' -ForegroundColor Yellow
    Write-Host '  mux-gui draws with WebView2 and this machine does not have it.'
    Write-Host '  Install it, then mux-gui will work:'
    Write-Host '    https://go.microsoft.com/fwlink/p/?LinkId=2124703' -ForegroundColor Cyan
    Write-Host '  The console version does not need it.'
    Write-Host ''
}

Write-Host '  Open a new terminal for PATH to take effect, or start it now with:'
Write-Host "    & '$(Join-Path $InstallDir 'mux-gui.exe')'" -ForegroundColor Cyan
Write-Host ''
