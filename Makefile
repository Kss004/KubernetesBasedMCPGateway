.PHONY: help up down reset secrets seed test-netpol

# Release/namespace names match scripts/seed.sh defaults (GW_NS, STORE_RELEASE,
# GW_RELEASE). Image tags must stay in sync with charts/*/values.yaml.
CLUSTER ?= urumi
GW_NS ?= urumi-gateway
STORE_NS ?= urumi-store
UP_NS ?= urumi-upstreams
GW_RELEASE ?= gateway
STORE_RELEASE ?= store
UP_RELEASE ?= upstreams
GATEWAY_IMG ?= gateway
GATEWAY_TAG ?= 0.3.2
WOO_IMG ?= woo-mcp
WOO_TAG ?= 0.1.3
MOCK_IMG ?= mock-mcp
MOCK_TAG ?= 0.1.0
EVERYTHING_IMG ?= everything-mcp
EVERYTHING_TAG ?= 0.1.0

help: ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

up: ## Create cluster, install ingress, build+load images, secrets, helm install, seed
	kind get clusters | grep -q '^$(CLUSTER)$$' || kind create cluster --config kind.yaml
	helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
	helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version 4.15.1 -n ingress-nginx --create-namespace --set controller.hostPort.enabled=true --set-string controller.nodeSelector.ingress-ready=true --set-string controller.tolerations[0].key=node-role.kubernetes.io/control-plane --set-string controller.tolerations[0].operator=Exists --set-string controller.tolerations[0].effect=NoSchedule --set controller.terminationGracePeriodSeconds=0
	docker build -t $(GATEWAY_IMG):$(GATEWAY_TAG) -f apps/gateway/Dockerfile .
	docker build -t $(WOO_IMG):$(WOO_TAG) -f apps/woo-mcp/Dockerfile .
	docker build -t $(MOCK_IMG):$(MOCK_TAG) -f apps/mock-mcp/Dockerfile .
	docker build -t $(EVERYTHING_IMG):$(EVERYTHING_TAG) -f apps/everything-mcp/Dockerfile .
	kind load docker-image $(GATEWAY_IMG):$(GATEWAY_TAG) --name $(CLUSTER)
	kind load docker-image $(WOO_IMG):$(WOO_TAG) --name $(CLUSTER)
	kind load docker-image $(MOCK_IMG):$(MOCK_TAG) --name $(CLUSTER)
	kind load docker-image $(EVERYTHING_IMG):$(EVERYTHING_TAG) --name $(CLUSTER)
	kubectl create ns $(GW_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl create ns $(STORE_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl create ns $(UP_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n $(GW_NS) get secret llm >/dev/null 2>&1 || kubectl -n $(GW_NS) create secret generic llm --from-literal=api-key=placeholder-change-me
	helm upgrade --install $(STORE_RELEASE) ./charts/store -n $(STORE_NS)
	helm upgrade --install $(UP_RELEASE) ./charts/upstreams -n $(UP_NS)
	helm upgrade --install $(GW_RELEASE) ./charts/gateway -n $(GW_NS)
	kubectl -n $(GW_NS) wait --for=condition=available deploy/$(GW_RELEASE)-gateway --timeout=180s
	GW_NS="$(GW_NS)" STORE_RELEASE="$(STORE_RELEASE)" GW_RELEASE="$(GW_RELEASE)" bash scripts/seed.sh

down: ## helm uninstall, keep data (PVCs/Secrets carry keep policy, D20)
	helm uninstall $(GW_RELEASE) -n $(GW_NS) || true
	helm uninstall $(UP_RELEASE) -n $(UP_NS) || true
	helm uninstall $(STORE_RELEASE) -n $(STORE_NS) || true

reset: ## Delete the kind cluster for a clean run (D19; dangerous: ask first)
	kind delete cluster --name urumi

secrets: ## Create out-of-band secrets (LLM key) via kubectl (never in values)
	@if [ -z "$(LLM_API_KEY)" ]; then echo "set LLM_API_KEY=... (never commit it)"; exit 1; fi
	kubectl -n $(GW_NS) create secret generic llm --from-literal=api-key="$(LLM_API_KEY)" --dry-run=client -o yaml | kubectl apply -f -

seed: ## Register woo-mcp via admin API using kubectl-read token (T3.6)
	bash scripts/seed.sh

test-netpol: ## Baseline+pair NetworkPolicy enforcement test (T1.1)
	bash scripts/test-netpol.sh
