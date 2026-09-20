# ==========================================
# Claude Code x Codex Plan Review
# ==========================================

# Max Claude-revision + Codex-re-review cycles (the initial Codex review is not counted)
$MaxRevisionRounds = 5

# Model
$ClaudeModel = "sonnet"
$CodexModel  = "gpt-5.6-terra"

# UTF-8
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Claude Session
$ClaudeSessionId = [guid]::NewGuid().ToString()

Write-Host "=== Claude x Codex Plan Review ==="
Write-Host "Claude Session: $ClaudeSessionId"


# ==========================================
# History (Audit Trail)
#   PLAN.md    = State
#   REVIEW.md / RESPONSE.md = Conversation
#   history/   = Audit Trail
# ==========================================

$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$HistoryDir = "history/$RunId"
New-Item -ItemType Directory -Path $HistoryDir -Force | Out-Null

Copy-Item "REQUIREMENT.md" "$HistoryDir/requirement.md"

$ConversationFile = "$HistoryDir/conversation.md"

@"
# Claude x Codex Review History

Run: $RunId
Started At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Current Directory: $(Get-Location)
Claude Model: $ClaudeModel
Codex Model: $CodexModel
Claude Session: $ClaudeSessionId
Max Revision Rounds: $MaxRevisionRounds

"@ | Set-Content $ConversationFile -Encoding UTF8

Write-Host "History: $HistoryDir"

function Get-RoundDir([int]$n) {
    $dir = "$HistoryDir/round-$($n.ToString('00'))"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

# 保存 Codex 該輪 Review
function Save-Review([int]$n) {
    $dir = Get-RoundDir $n
    Copy-Item "REVIEW.md" "$dir/review.md"

    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

## Round $n - Codex Review

$(Get-Content "REVIEW.md" -Raw -Encoding UTF8)
"@
}

# 正常結束（APPROVED / NEEDS_HUMAN / MAX_ROUNDS）：保存最終 Plan 與 Run 摘要
function Complete-Run([string]$status, [int]$rounds, [int]$code) {
    if (Test-Path "PLAN.md") {
        Copy-Item "PLAN.md" "$HistoryDir/final-plan.md"
    }

    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

# Final Result

STATUS: $status
Total Review Rounds: $rounds
Finished At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Final Plan: final-plan.md
"@

    exit $code
}

# CLI / Artifact 失敗：記錄失敗階段，區分「無法收斂」與「執行失敗」
function Stop-Run([string]$stage, [int]$round, [int]$exitCode) {
    Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

# Run Failed

Stage: $stage
Round: $round
Exit Code: $exitCode
Finished At: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@

    Write-Host "ERROR: $stage"
    exit 1
}


# ==========================================
# Round 1 - Claude 建立 Plan
# ==========================================

Write-Host ""
Write-Host "[Claude] Creating initial PLAN.md..."

claude `
    --model $ClaudeModel `
    --permission-mode acceptEdits `
    --session-id $ClaudeSessionId `
    -p @"
Read REQUIREMENT.md.
Follow CLAUDE.md.

Create a planning proposal in PLAN.md.

Planning only.
Do not implement source code.
"@

if ($LASTEXITCODE -ne 0) {
    Stop-Run "Claude initial plan failed" 0 $LASTEXITCODE
}

if (-not (Test-Path "PLAN.md")) {
    Stop-Run "PLAN.md was not created" 0 0
}

Copy-Item "PLAN.md" "$HistoryDir/00-plan-initial.md"

Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

## Initial Plan

Claude created the initial plan (see 00-plan-initial.md).
"@


# ==========================================
# Round 1 - Codex Review
# ==========================================

Write-Host ""
Write-Host "[Codex] Reviewing initial plan..."

if (Test-Path "REVIEW.md") {
    Remove-Item "REVIEW.md" -Force
}

codex exec `
    --model $CodexModel `
    --sandbox workspace-write `
    @"
Review PLAN.md against REQUIREMENT.md.
Follow AGENTS.md.

Create REVIEW.md with the review result.

The file must contain exactly one status:
STATUS: APPROVED
STATUS: CHANGES_REQUESTED
or
STATUS: NEEDS_HUMAN

Do not modify PLAN.md.
Do not implement source code.
"@

if ($LASTEXITCODE -ne 0) {
    Stop-Run "Codex initial review failed" 0 $LASTEXITCODE
}

if (-not (Test-Path "REVIEW.md")) {
    Stop-Run "Codex did not create REVIEW.md (initial review)" 0 0
}


# ==========================================
# Discussion Loop
#   round-NN/review.md   = Codex review of the previous PLAN version
#   round-NN/response.md = Claude's answer to that review
#   round-NN/plan.md     = PLAN after Claude's changes
# ==========================================

for ($round = 1; $round -le $MaxRevisionRounds; $round++) {

    Write-Host ""
    Write-Host "=== Discussion Round $round ==="

    if (-not (Test-Path "REVIEW.md")) {
        Stop-Run "REVIEW.md not found" $round 0
    }

    $review = Get-Content "REVIEW.md" -Raw -Encoding UTF8

    Save-Review $round


    # ------------------------------------------
    # APPROVED
    # ------------------------------------------

    if ($review -match "(?m)^STATUS:\s*APPROVED\s*$") {

        Write-Host ""
        Write-Host "=============================="
        Write-Host " PLAN APPROVED"
        Write-Host " Ready for Human Review"
        Write-Host "=============================="

        Complete-Run "APPROVED" $round 0
    }


    # ------------------------------------------
    # NEEDS HUMAN
    # ------------------------------------------

    if ($review -match "(?m)^STATUS:\s*NEEDS_HUMAN\s*$") {

        Write-Host ""
        Write-Host "=============================="
        Write-Host " HUMAN DECISION REQUIRED"
        Write-Host "=============================="

        Complete-Run "NEEDS_HUMAN" $round 2
    }


    # ------------------------------------------
    # Claude 處理 Review
    # ------------------------------------------

    if ($review -match "(?m)^STATUS:\s*CHANGES_REQUESTED\s*$") {

        Write-Host "[Claude] Processing review..."

        # 避免 Claude 沒寫新的 RESPONSE.md 時讀到上一輪的
        if (Test-Path "RESPONSE.md") {
            Remove-Item "RESPONSE.md" -Force
        }

        claude `
            --model $ClaudeModel `
            --permission-mode acceptEdits `
            --resume $ClaudeSessionId `
            -p @"
Read the latest REVIEW.md.

Evaluate every Codex finding.

For each finding decide:
- ACCEPT
- REJECT
- ALTERNATIVE

Update PLAN.md when appropriate.

Also create RESPONSE.md in this format, one section per finding:

# Claude Response

## <finding id>
Decision: ACCEPT | REJECT | ALTERNATIVE

Reason:
<why>

Action:
<what changed in PLAN.md, or "None" for REJECT>

Do not blindly accept suggestions.
The goal is convergence.

Planning only.
Do not implement source code.
"@

        if ($LASTEXITCODE -ne 0) {
            Stop-Run "Claude review processing failed" $round $LASTEXITCODE
        }

        if (-not (Test-Path "RESPONSE.md")) {
            Stop-Run "Claude did not create RESPONSE.md" $round 0
        }

        if (-not (Test-Path "PLAN.md")) {
            Stop-Run "PLAN.md missing after Claude revision" $round 0
        }

        # 保存 Claude 該輪回應與更新後的 Plan
        $RoundDir = Get-RoundDir $round
        Copy-Item "RESPONSE.md" "$RoundDir/response.md"
        Copy-Item "PLAN.md" "$RoundDir/plan.md"

        Add-Content $ConversationFile -Encoding UTF8 -Value @"

---

## Round $round - Claude

$(Get-Content "RESPONSE.md" -Raw -Encoding UTF8)
"@
    }
    else {
        Stop-Run "Unknown REVIEW status" $round 0
    }


    # ------------------------------------------
    # Codex Re-review
    # ------------------------------------------

    Write-Host "[Codex] Re-reviewing PLAN.md..."

    # 刪除上一輪 Review，避免 Codex patch 舊檔 / Claude 誤讀 stale review
    if (Test-Path "REVIEW.md") {
        Remove-Item "REVIEW.md" -Force
    }

    codex exec `
        --sandbox workspace-write `
        resume `
        --last `
        --model $CodexModel `
        @"
Re-review the latest PLAN.md.

Consider the previous discussion and Claude's changes.
Follow AGENTS.md.

Create a new REVIEW.md with the latest review result.

The file must contain exactly one status:
STATUS: APPROVED
STATUS: CHANGES_REQUESTED
or
STATUS: NEEDS_HUMAN

Do not modify PLAN.md.
Do not implement source code.
"@

    if ($LASTEXITCODE -ne 0) {
        Stop-Run "Codex re-review failed" $round $LASTEXITCODE
    }

    # Codex 回報成功，但沒有真的產生檔案
    if (-not (Test-Path "REVIEW.md")) {
        Stop-Run "Codex did not create REVIEW.md (re-review)" $round 0
    }
}


# ==========================================
# Maximum rounds
# ==========================================

# 最後一次 Re-review 不會進入迴圈，這裡補存
if (Test-Path "REVIEW.md") {
    Save-Review ($MaxRevisionRounds + 1)
}

Write-Host ""
Write-Host "=============================="
Write-Host " MAX REVIEW ROUNDS REACHED"
Write-Host " Human review required"
Write-Host "=============================="

Complete-Run "MAX_ROUNDS_REACHED" ($MaxRevisionRounds + 1) 2
