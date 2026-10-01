<#
    Generates a self-signed certificate so the API can serve HTTPS locally.

    This certificate is for development only. It is not trusted by anything, so
    a browser will warn once and a command line client needs -k. Real hosting
    replaces it with a certificate from an authority; no code changes when it
    does, only TLS_CERT_FILE and TLS_KEY_FILE.

    The output is written to server/certs/, which .gitignore excludes. Nothing
    produced here may be committed.

    Usage:
        .\scripts\gen-dev-cert.ps1
        .\scripts\gen-dev-cert.ps1 -Force
#>
param(
    [string] $OutDir = (Join-Path $PSScriptRoot '..\server\certs'),
    [int] $Days = 365,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# PostgreSQL ships a native openssl, which is preferred because Git's build
# rewrites arguments that start with a slash. MSYS2_ARG_CONV_EXCL below covers
# the Git build if that is the one found.
$candidates = @(
    'C:\Program Files\PostgreSQL\16\bin\openssl.exe',
    'openssl',
    'C:\Program Files\Git\usr\bin\openssl.exe',
    'C:\Program Files\Git\mingw64\bin\openssl.exe'
)

$openssl = $null
foreach ($candidate in $candidates) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) { $openssl = $found.Source; break }
}

if (-not $openssl) {
    Write-Host 'Could not find openssl.' -ForegroundColor Red
    Write-Host 'It ships with both PostgreSQL and Git for Windows. Add one of their bin folders to PATH and run this again.'
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$keyFile  = Join-Path $OutDir 'localhost-key.pem'
$certFile = Join-Path $OutDir 'localhost-cert.pem'

if ((Test-Path $keyFile) -and -not $Force) {
    Write-Host "A certificate already exists at $OutDir. Use -Force to replace it." -ForegroundColor Yellow
    exit 0
}

Write-Host "Using $openssl"
$env:MSYS2_ARG_CONV_EXCL = '*'

# A subject alternative name is required: browsers stopped accepting the common
# name on its own. Both names are listed so https://localhost and
# https://127.0.0.1 are each valid.
& $openssl req -x509 -newkey rsa:2048 -nodes `
    -keyout $keyFile `
    -out $certFile `
    -days $Days `
    -subj '/CN=localhost' `
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'

if ($LASTEXITCODE -ne 0) {
    Write-Host 'openssl failed.' -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ''
Write-Host "Certificate written to $OutDir (valid for $Days days)." -ForegroundColor Green
Write-Host 'Set these in server/.env, or in the shell before starting the API:'
Write-Host ''
Write-Host "    TLS_CERT_FILE=$certFile"
Write-Host "    TLS_KEY_FILE=$keyFile"
Write-Host ''
Write-Host 'The API then serves https://localhost:4000. Without them it serves plain HTTP, which is what CI uses.'
