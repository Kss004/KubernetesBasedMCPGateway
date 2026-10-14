# windows-coding-setup.md — PC (WSL2) setup, recorded from actual commands (T0.1)

> Spec: `progrestillnow.md` §3. Values below are what `T0.1` actually ran/saw on 2026-10-09. Where actual differs from spec, actual wins and spec is flagged.

## 1. WSL2 + repo location

- Windows user: `Shashwat` (`/mnt/c/Users/Shashwat`). WSL user: `kss`.
- Repo lives in the WSL filesystem at `/home/kss/projects/github/KubernetesBasedMCPGateway` — **not** `/mnt/c`. (Spec's `~/urumi` is stale; actual path is the repo root above.)
- Never work from `/mnt/c` (slow IO + CRLF risk).

## 2. `.wslconfig` (actual, differs from spec)

Spec §3 says `memory=20GB, processors=8, swap=8GB`. Actual file
`C:\Users\Shashwat\.wslconfig` (`/mnt/c/Users/Shashwat/.wslconfig`) contains:

```ini
[wsl2]
memory=24GB
processors=12
swap=8GB
```

Evidence (T0.1 run):

```text
free -h → Mem: 23Gi  Swap: 8.0Gi
docker info --format → MemTotal=25203019776 NCPU=12
```

Kept as-is for now: 24GB/12 leaves ~8GB for Windows on this 32GB box and gives more headroom than spec (risk R3). Do **not** silently downgrade to 20GB/8 — confirm with human first. Changing it requires editing the file in Windows, then `wsl --shutdown` from PowerShell and reopening (kills the session — human runs it).

## 3. Docker

- Docker Desktop with WSL2 backend. Do **not** also install native Docker Engine inside WSL2.
- `docker --version` → `Docker 29.8.2, build 7fc2dff` (from scout; re-check with `docker version` if needed).

## 4. Tools inside WSL (actual `T0.1` output)

```text
kind v0.33.0 go1.26.7 linux/amd64
helm version → v4.3.0 (KubeClient v1.37)
kubectl → Client Version: v1.36.1, Kustomize v5.8.1
node -v → v24.21.0
npm -v → 11.19.0
make → NOT FOUND (human runs: sudo apt update && sudo apt install -y make)
```

Install (human runs, needs sudo):

```sh
sudo apt update && sudo apt install -y make
make -v   # verify
```

## 5. Git line endings (T0.2 does this, noted here)

```sh
git config --global core.autocrlf input
# repo .gitattributes: * text=auto eol=lf
```

## 6. Ollama (fallback LLM, D10)

- Stays on the Windows side (GPU). Pods reach it by host address. Nothing installed in WSL for it in T0.1.

## 7. Verify (T0.1)

```sh
cat /mnt/c/Users/$USER/.wslconfig 2>/dev/null || cat /mnt/c/Users/Shashwat/.wslconfig
free -h
docker info --format 'MemTotal={{.MemTotal}} NCPU={{.NCPU}}'
kind version; helm version; kubectl version --client; node -v; make -v
```

Pass = memory/CPU match `.wslconfig`, all versions print. `make` currently fails — expected until human apt-installs it.

## 8. Ingress hostnames for CLI tools (added 2026-10-14)

Browsers resolve `*.localhost` to loopback on their own, but CLI tools inside
WSL2 (Node, MCP Inspector) did not. Fix: map them in WSL2's `/etc/hosts`
(human runs, needs sudo — persists across WSL restarts):

```sh
grep -q 'app.localhost' /etc/hosts || echo '127.0.0.1 app.localhost shop.localhost' | sudo tee -a /etc/hosts
getent hosts app.localhost shop.localhost
```
