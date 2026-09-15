<#
.SYNOPSIS
    Creates the Rasibe database and applies every script in order.

.DESCRIPTION
    The Windows equivalent of apply.sh. Checks that PostgreSQL is reachable,
    creates the database if it does not exist, applies the four scripts in
    order, and grants the application role what it needs.

.PARAMETER Database
    Database name. Defaults to rasibe.

.PARAMETER User
    PostgreSQL superuser used to create the database. Defaults to postgres.

.PARAMETER Recreate
    Drops the database first. Everything in it is lost.

.EXAMPLE
    .\apply.ps1

.EXAMPLE
    .\apply.ps1 -Recreate

.EXAMPLE
    .\apply.ps1 -Database rasibe_dev -User postgres
#>

[CmdletBinding()]
param(
    [string]$Database = 'rasibe',
    [string]$User = 'postgres',
    [switch]$Recreate
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Step { param($m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  $m" -ForegroundColor Yellow }

Write-Host ""
Write-Host "Rasibe Consultant Placement Management System" -ForegroundColor White
Write-Host "Database setup" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------
# 1. Is PostgreSQL on the PATH?
# ---------------------------------------------------------------------
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Warn "psql was not found on your PATH."
    Write-Host ""
    Write-Host "  If PostgreSQL is installed, add it for this session:" -ForegroundColor DarkGray

    $candidates = @()
    foreach ($v in 18, 17, 16) {
        $p = "C:\Program Files\PostgreSQL\$v\bin"
        if (Test-Path $p) { $candidates += $p }
    }

    if ($candidates.Count -gt 0) {
        Write-Host ""
        Write-Host "      `$env:Path += `";$($candidates[0])`"" -ForegroundColor White
        Write-Host ""
        Write-Host "  Found an installation there. Adding it now." -ForegroundColor DarkGray
        $env:Path += ";$($candidates[0])"
    }
    else {
        Write-Host ""
        Write-Host "      `$env:Path += `";C:\Program Files\PostgreSQL\16\bin`"" -ForegroundColor White
        Write-Host ""
        Write-Host "  If PostgreSQL is not installed, get version 16 or later from" -ForegroundColor DarkGray
        Write-Host "  https://www.postgresql.org/download/windows/" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  This system needs 16 or later. It relies on EXCLUDE USING gist," -ForegroundColor DarkGray
        Write-Host "  row-level security and security_invoker views." -ForegroundColor DarkGray
        exit 1
    }
}

$version = (& psql --version) -join ''
Write-Ok "Found $version"

# ---------------------------------------------------------------------
# 2. Password, asked once rather than on every command
# ---------------------------------------------------------------------
if (-not $env:PGPASSWORD) {
    Write-Host ""
    Write-Step "Password for PostgreSQL user '$User'"
    $secure = Read-Host -Prompt "  Password" -AsSecureString
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$env:PGUSER = $User

# ---------------------------------------------------------------------
# 3. Can we reach the server?
# ---------------------------------------------------------------------
Write-Host ""
& psql -d postgres -c "SELECT 1;" *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Could not connect to PostgreSQL as '$User'."
    Write-Host ""
    Write-Host "  Check that the service is running:" -ForegroundColor DarkGray
    Write-Host "      Get-Service postgresql*" -ForegroundColor White
    Write-Host ""
    Write-Host "  and that the password is correct." -ForegroundColor DarkGray
    exit 1
}
Write-Ok "Connected to PostgreSQL"

# ---------------------------------------------------------------------
# 4. Create the database
# ---------------------------------------------------------------------
if ($Recreate) {
    Write-Step "Dropping '$Database' if it exists"
    & psql -d postgres -c "DROP DATABASE IF EXISTS $Database;" *> $null
}

$exists = & psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$Database';"
if ($exists -eq '1') {
    Write-Ok "Database '$Database' already exists"
    if (-not $Recreate) {
        Write-Warn "Applying the scripts to an existing database will fail if the"
        Write-Warn "schema is already there. Use -Recreate to start clean."
        Write-Host ""
        $answer = Read-Host "  Continue anyway? (y/N)"
        if ($answer -ne 'y') { exit 0 }
    }
}
else {
    Write-Step "Creating database '$Database'"
    & psql -d postgres -c "CREATE DATABASE $Database;" *> $null
    if ($LASTEXITCODE -ne 0) { Write-Warn "Could not create the database."; exit 1 }
    Write-Ok "Created"
}

# ---------------------------------------------------------------------
# 5. Apply the scripts in order
# ---------------------------------------------------------------------
$scripts = @(
    @{ File = '01_schema.sql';   Description = 'Tables, enumerated types and constraints' },
    @{ File = '02_security.sql'; Description = 'Roles, row-level security and projection views' },
    @{ File = '03_triggers.sql'; Description = 'State machines and financial invariants' },
    @{ File = '04_seed.sql';     Description = 'Reference data and demonstration data' }
)

Write-Host ""
foreach ($s in $scripts) {
    if (-not (Test-Path $s.File)) {
        Write-Warn "$($s.File) is missing. Run this from the db folder."
        exit 1
    }
    Write-Step "$($s.File) — $($s.Description)"
    $output = & psql -d $Database -v ON_ERROR_STOP=1 -f $s.File 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Warn "Failed while applying $($s.File):"
        $output | Where-Object { $_ -match 'ERROR|FATAL' } | Select-Object -First 5 |
            ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
        exit 1
    }
}

# ---------------------------------------------------------------------
# 6. Grants for the application role
# ---------------------------------------------------------------------
Write-Step "Granting the application role access"
$grants = @"
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
REVOKE UPDATE, DELETE ON audit_entry FROM rasibe_app;
"@
& psql -d $Database -c $grants *> $null

# ---------------------------------------------------------------------
# 7. Report what was built
# ---------------------------------------------------------------------
$tables = & psql -d $Database -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"
$policies = & psql -d $Database -tAc "SELECT count(*) FROM pg_policies;"
$triggers = & psql -d $Database -tAc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;"
$users = & psql -d $Database -tAc "SELECT count(*) FROM app_user;"

Write-Host ""
Write-Ok "Database '$Database' is ready"
Write-Host ""
Write-Host "      Tables           $($tables.Trim())"   -ForegroundColor DarkGray
Write-Host "      RLS policies     $($policies.Trim())" -ForegroundColor DarkGray
Write-Host "      Triggers         $($triggers.Trim())" -ForegroundColor DarkGray
Write-Host "      Demo accounts    $($users.Trim())"    -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Next:" -ForegroundColor White
Write-Host "      cd ..\server" -ForegroundColor White
Write-Host "      Copy-Item .env.example .env" -ForegroundColor White
Write-Host "      npm install" -ForegroundColor White
Write-Host "      npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "  Then in a second terminal:" -ForegroundColor White
Write-Host "      cd ..\web" -ForegroundColor White
Write-Host "      npm install" -ForegroundColor White
Write-Host "      npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "  Edit server\.env so PGUSER and PGPASSWORD match your setup." -ForegroundColor DarkGray
Write-Host "  The application connects as rasibe_app, not as postgres." -ForegroundColor DarkGray
Write-Host ""

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
