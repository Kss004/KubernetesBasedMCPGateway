.PHONY: help up down reset secrets seed test-netpol

help: ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

up: ## Create cluster, install ingress, build+load images, secrets, helm install, seed (T1.1 fills in)
	@echo "TODO(T1.1+): not wired yet"

down: ## helm uninstall, keep data (later tasks fill in)
	@echo "TODO(P1): not wired yet"

reset: ## Delete cluster/namespaces+PVCs for a clean run (D19/D20; dangerous: ask first)
	@echo "TODO(T1.1): not wired yet"

secrets: ## Create out-of-band secrets (LLM key etc.) via kubectl (T6.1 fills in)
	@echo "TODO(T6.1): not wired yet"

seed: ## Register woo-mcp via admin API using kubectl-read token (T3.6 fills in)
	@echo "TODO(T3.6): not wired yet"

test-netpol: ## Baseline+pair NetworkPolicy enforcement test (T1.1 fills in)
	@echo "TODO(T1.1): not wired yet"
