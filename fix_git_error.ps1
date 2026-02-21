
Write-Host "Starting Git Push Fix..."

# Try to remove node_modules if it exists
if (Test-Path "node_modules") {
    Write-Host "Removing node_modules..."
    try {
        Remove-Item -Recurse -Force "node_modules" -ErrorAction Stop
    } catch {
        Write-Error "Failed to remove node_modules. Please ensure all node processes (server, etc.) are stopped and try again."
        exit 1
    }
}

# Pull remote changes
Write-Host "Pulling remote changes..."
git pull --rebase origin main
if ($LASTEXITCODE -ne 0) {
    Write-Error "Git pull failed. Please check the error message."
    exit 1
}

# Untrack node_modules if present in git
if (git ls-files node_modules) {
    Write-Host "Untracking node_modules..."
    git rm -r --cached node_modules
    git commit -m "chore: stop tracking node_modules"
}

# Pop stash if saved
git stash list | Select-String "stash@{0}" | Out-Null
if ($?) {
    Write-Host "Restoring local changes..."
    git stash pop
}

# Push changes
Write-Host "Pushing changes..."
git push origin main

Write-Host "Done! Please run 'npm install' to restore dependencies."
