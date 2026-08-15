# Auto-start the token-free gateway stack after logon.
# 1. Launch Chrome with remote debugging (profile Chrome-TFG-Debug, port 9222).
# 2. Wait for CDP to answer, then start the dev gateway (bun index.ts) on 3461.
$ErrorActionPreference = "SilentlyContinue"

$chrome = @(
	"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
	"$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
	"${env:PROGRAMFILES(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# Chrome debug instance (port 9222)
$cdpUp = $false
try {
	Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 3 | Out-Null
	$cdpUp = $true
} catch { }

if (-not $cdpUp) {
	if ($chrome) {
		$ud = "$env:LOCALAPPDATA\Chrome-TFG-Debug"
		Start-Process -FilePath $chrome -ArgumentList @(
			"--remote-debugging-port=9222",
			"--user-data-dir=$ud",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--remote-allow-origins=*"
		) -WindowStyle Hidden
		for ($i = 0; $i -lt 20; $i++) {
			Start-Sleep -Milliseconds 750
			try {
				Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
				$cdpUp = $true
				break
			} catch { }
		}
	}
}

if (-not $cdpUp) {
	Write-Output "Chrome CDP not available on 9222 - gateway will retry via its own browser manager."
}

# Gateway (dev repo, port 3461)
$gwUp = $false
try {
	Invoke-WebRequest -Uri "http://127.0.0.1:3461/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
	$gwUp = $true
} catch { }

if (-not $gwUp) {
	$gatewayDir = "C:\VectorHQ\token-free-gateway-dev"
	if (Test-Path "$gatewayDir\index.ts") {
		Start-Process -FilePath "bun" -ArgumentList "index.ts" -WorkingDirectory $gatewayDir -WindowStyle Hidden
	}
}
