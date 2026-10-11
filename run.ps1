# One command to set up and run Baton on Windows PowerShell: .\run.ps1
# Set $env:REBUILD = "1" first to rebuild the web app. (macOS, Linux and Git Bash: ./run.sh)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Repo-local Node, if someone unzipped one into .tools\node
if (Test-Path ".tools\node\node.exe") { $env:PATH = "$PSScriptRoot\.tools\node;$env:PATH" }

$python = ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    $found = $null
    foreach ($c in @($env:PYTHON, "py", "python", "python3") | Where-Object { $_ }) {
        if (Get-Command $c -ErrorAction SilentlyContinue) {
            & $c -c "import sys; sys.exit(sys.version_info < (3, 10))" 2>$null
            if ($LASTEXITCODE -eq 0) { $found = $c; break }
        }
    }
    if (-not $found) { Write-Error "Baton needs Python 3.10 or newer." }
    Write-Host "Creating virtualenv with $found..."
    & $found -m venv .venv
    & $python -m pip install -q --upgrade pip
    & $python -m pip install -q -r requirements.txt
}

if (-not (Test-Path "web\dist\index.html") -or $env:REBUILD -eq "1") {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Error "Building the web app needs Node 20.19+ (with npm)." }
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)'
    if ($LASTEXITCODE -ne 0) { Write-Error "Node $(node --version) is too old to build the web app; install Node 20.19+ or 22.12+." }
    Write-Host "Building the web app..."
    Push-Location web
    try {
        npm install --silent
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        npm run build --silent
        if ($LASTEXITCODE -ne 0) { throw "web build failed" }
    } finally { Pop-Location }
}

$env:PYTHONPATH = "backend"
& $python -m baton
