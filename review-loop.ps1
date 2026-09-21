param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
    [string]$WorkItem,

    [ValidateRange(1, 20)]
    [int]$MaxRevisionRounds = 5,

    [string]$ClaudeModel = "sonnet",
    [string]$CodexModel = "gpt-5.6-terra"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = $PSScriptRoot
$WorkItemDir = Join-Path $RepoRoot "work-items/$WorkItem"
$MetadataFile = Join-Path $WorkItemDir "work-item.json"
$RequirementFile = Join-Path $WorkItemDir "REQUIREMENT.md"

if (-not (Test-Path $WorkItemDir -PathType Container)) {
    throw "Work item '$WorkItem' does not exist: $WorkItemDir"
}
if (-not (Test-Path $MetadataFile -PathType Leaf)) {
    throw "work-item.json not found: $MetadataFile"
}
if (-not (Test-Path $RequirementFile -PathType Leaf)) {
    throw "REQUIREMENT.md not found: $RequirementFile"
}

Set-Location $WorkItemDir

$ClaudeSessionId = [guid]::NewGuid().ToString()
$CodexSessionId = $null
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$HistoryDir = Join-Path "history" $RunId
$ConversationFile = Join-Path $HistoryDir "conversation.md"
$RunFile = Join-Path $HistoryDir "run.json"

function Save-JsonAtomic([string]$Path, [object]$Value) {
    $temp = "$Path.tmp"
    $Value | ConvertTo-Json -Depth 10 | Set-Content $temp -Encoding UTF8
    Get-Content $temp -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
    Move-Item $temp $Path -Force
}

function Update-WorkItem([string]$Status) {
    $meta = Get-Content $MetadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $meta.status = $Status
    $meta.latestRunId = $RunId
    if ($meta.PSObject.Properties.Name -contains "updatedAt") {
        $meta.updatedAt = (Get-Date).ToString("o")
    }
    else {
        $meta | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToString("o")
    }
    Save-JsonAtomic $MetadataFile $meta
}

function Write-RunMetadata([string]$Status) {
    $data = [ordered]@{
        schemaVersion = 1
        runId = $RunId
        workItemId = $WorkItem
        status = $Status
        startedAt = $script:StartedAt
        updatedAt = (Get-Date).ToString("o")
        maxRevisionRounds = $MaxRevisionRounds
        claude = [ordered]@{ model = $ClaudeModel; sessionId = $ClaudeSessionId }
        codex = [ordered]@{ model = $CodexModel; sessionId = $CodexSessionId }
    }
    Save-JsonAtomic $RunFile $data
}

function Get-RoundDir([int]$Number) {
    $dir = Join-Path $HistoryDir "round-$($Number.ToString('00'))"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Save-Review([int]$Number) {
    $dir = Get-RoundDir $Number
    Copy-Item "REVIEW.md" (Join-Path $dir "review.md") -Force
    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

## Round $Number - Codex Review

$(Get-Content "REVIEW.md" -Raw -Encoding UTF8)
"@
}

function Complete-Run([string]$Status, [int]$Rounds, [int]$Code) {
    if (Test-Path "PLAN.md") {
        Copy-Item "PLAN.md" (Join-Path $HistoryDir "final-plan.md") -Force
    }
    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

# Final Result

STATUS: $Status
Total Review Rounds: $Rounds
Finished At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Final Plan: final-plan.md
"@
    $workItemStatus = switch ($Status) {
        "APPROVED" { "PLAN_APPROVED" }
        "NEEDS_HUMAN" { "NEEDS_HUMAN" }
        "MAX_ROUNDS_REACHED" { "NEEDS_HUMAN" }
        default { $Status }
    }
    Update-WorkItem $workItemStatus
    Write-RunMetadata $Status
    exit $Code
}

function Stop-Run([string]$Stage, [int]$Round, [int]$ExitCode) {
    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

# Run Failed

Stage: $Stage
Round: $Round
Exit Code: $ExitCode
Finished At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@
    Update-WorkItem "FAILED"
    Write-RunMetadata "FAILED"
    Write-Error $Stage
    exit 1
}

function Invoke-CodexInitialReview {
    if (Test-Path "REVIEW.md") { Remove-Item "REVIEW.md" -Force }

    $output = & codex exec `
        --skip-git-repo-check `
        --model $CodexModel `
        --sandbox workspace-write `
        --json `
        @"
Review PLAN.md against REQUIREMENT.md.
Follow $RepoRoot/AGENTS.md.
Create REVIEW.md with exactly one status: STATUS: APPROVED, STATUS: CHANGES_REQUESTED, or STATUS: NEEDS_HUMAN.
Do not modify PLAN.md and do not implement source code.
"@ 2>&1
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { Stop-Run "Codex initial review failed" 0 $code }

    $thread = $output | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $_.type -eq "thread.started" } | Select-Object -First 1

    if (-not $thread -or -not $thread.thread_id) {
        Stop-Run "Codex thread ID not found" 0 0
    }
    $script:CodexSessionId = $thread.thread_id
    Write-RunMetadata "RUNNING"
    if (-not (Test-Path "REVIEW.md")) {
        Stop-Run "Codex did not create REVIEW.md (initial review)" 0 0
    }
}

$script:StartedAt = (Get-Date).ToString("o")
New-Item -ItemType Directory -Path $HistoryDir -Force | Out-Null
Copy-Item "REQUIREMENT.md" (Join-Path $HistoryDir "requirement.md")
Update-WorkItem "PLAN_REVIEW"
Write-RunMetadata "RUNNING"

@"
# Claude x Codex Review History

Run: $RunId
Work Item: $WorkItem
Started At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Current Directory: $(Get-Location)
Claude Model: $ClaudeModel
Codex Model: $CodexModel
Claude Session: $ClaudeSessionId
Max Revision Rounds: $MaxRevisionRounds
"@ | Set-Content $ConversationFile -Encoding UTF8

Write-Host "=== Claude x Codex Plan Review ==="
Write-Host "Work Item: $WorkItem"
Write-Host "Run: $RunId"

Write-Host "[Claude] Creating initial PLAN.md..."
& claude `
    --model $ClaudeModel `
    --permission-mode acceptEdits `
    --session-id $ClaudeSessionId `
    -p @"
Read REQUIREMENT.md and follow $RepoRoot/CLAUDE.md.
Create a planning proposal in PLAN.md. Planning only; do not implement source code.
"@
$code = $LASTEXITCODE
if ($code -ne 0) { Stop-Run "Claude initial plan failed" 0 $code }
if (-not (Test-Path "PLAN.md")) { Stop-Run "PLAN.md was not created" 0 0 }

Copy-Item "PLAN.md" (Join-Path $HistoryDir "00-plan-initial.md")
Add-Content $ConversationFile -Encoding UTF8 -Value "`n---`n`n## Initial Plan`n`nClaude created the initial plan (see 00-plan-initial.md)."

Write-Host "[Codex] Reviewing initial plan..."
Invoke-CodexInitialReview
Write-Host "Codex Session: $CodexSessionId"

for ($round = 1; $round -le $MaxRevisionRounds; $round++) {
    Write-Host "=== Discussion Round $round ==="
    if (-not (Test-Path "REVIEW.md")) { Stop-Run "REVIEW.md not found" $round 0 }

    $review = Get-Content "REVIEW.md" -Raw -Encoding UTF8
    Save-Review $round

    if ($review -match "(?m)^STATUS:\s*APPROVED\s*$") {
        Complete-Run "APPROVED" $round 0
    }
    if ($review -match "(?m)^STATUS:\s*NEEDS_HUMAN\s*$") {
        Complete-Run "NEEDS_HUMAN" $round 2
    }
    if ($review -notmatch "(?m)^STATUS:\s*CHANGES_REQUESTED\s*$") {
        Stop-Run "Unknown REVIEW status" $round 0
    }

    if (Test-Path "RESPONSE.md") { Remove-Item "RESPONSE.md" -Force }
    Write-Host "[Claude] Processing review..."
    & claude `
        --model $ClaudeModel `
        --permission-mode acceptEdits `
        --resume $ClaudeSessionId `
        -p @"
Read the latest REVIEW.md. Evaluate every finding as ACCEPT, REJECT, or ALTERNATIVE.
Update PLAN.md when appropriate and create RESPONSE.md with one section per finding containing Decision, Reason, and Action.
Planning only; do not implement source code.
"@
    $code = $LASTEXITCODE
    if ($code -ne 0) { Stop-Run "Claude review processing failed" $round $code }
    if (-not (Test-Path "RESPONSE.md")) { Stop-Run "Claude did not create RESPONSE.md" $round 0 }
    if (-not (Test-Path "PLAN.md")) { Stop-Run "PLAN.md missing after Claude revision" $round 0 }

    $roundDir = Get-RoundDir $round
    Copy-Item "RESPONSE.md" (Join-Path $roundDir "response.md") -Force
    Copy-Item "PLAN.md" (Join-Path $roundDir "plan.md") -Force
    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

## Round $round - Claude

$(Get-Content "RESPONSE.md" -Raw -Encoding UTF8)
"@

    if (Test-Path "REVIEW.md") { Remove-Item "REVIEW.md" -Force }
    Write-Host "[Codex] Re-reviewing PLAN.md..."
    & codex exec `
        --skip-git-repo-check `
        --sandbox workspace-write `
        resume $CodexSessionId `
        --model $CodexModel `
        @"
Re-review the latest PLAN.md. Consider the previous discussion and Claude's changes.
Follow $RepoRoot/AGENTS.md. Create a new REVIEW.md with exactly one valid status.
Do not modify PLAN.md and do not implement source code.
"@
    $code = $LASTEXITCODE
    if ($code -ne 0) { Stop-Run "Codex re-review failed" $round $code }
    if (-not (Test-Path "REVIEW.md")) { Stop-Run "Codex did not create REVIEW.md (re-review)" $round 0 }
}

if (Test-Path "REVIEW.md") { Save-Review ($MaxRevisionRounds + 1) }
Complete-Run "MAX_ROUNDS_REACHED" ($MaxRevisionRounds + 1) 2
