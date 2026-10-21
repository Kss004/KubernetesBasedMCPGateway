.PHONY: help up fonts images down reset secrets seed test-netpol smoke e2e prod-up prod-check prod-down

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
GATEWAY_TAG ?= 0.4.17
WOO_IMG ?= woo-mcp
WOO_TAG ?= 0.1.7
MOCK_IMG ?= mock-mcp
MOCK_TAG ?= 0.1.1
EVERYTHING_IMG ?= everything-mcp
EVERYTHING_TAG ?= 0.1.1
IMAGES = $(GATEWAY_IMG):$(GATEWAY_TAG) $(WOO_IMG):$(WOO_TAG) $(MOCK_IMG):$(MOCK_TAG) $(EVERYTHING_IMG):$(EVERYTHING_TAG)

# Prod rehearsal on k3d (values-prod.yaml: Traefik, local-path). Own kubeconfig
# file, so kind stays the current context; ports 8081/8444 leave kind's 80/443 alone.
PROD_CLUSTER ?= urumi-prod
PROD_KUBECONFIG = $(HOME)/.config/k3d/kubeconfig-$(PROD_CLUSTER).yaml
PROD_PORT ?= 8081
PROD_TLS_PORT ?= 8444
PROD_APP ?= app.localhost
PROD_SHOP ?= shop.localhost
REGISTRY ?= ghcr.io/kss004/kubernetesbasedmcpgateway
# Must match llm.secretName in charts/gateway/values.yaml (llm-opencode = OpenCode Go; llm-groq = Groq; llm = Gemini).
LLM_SECRET ?= llm-opencode
# Must match llm.fallback.secretName (automatic fallback provider).
LLM_FALLBACK_SECRET ?= llm-groq

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

up: ## Create cluster, install ingress, build+load images, secrets, helm install, seed
	kind get clusters | grep -q '^$(CLUSTER)$$' || kind create cluster --config kind.yaml
	helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
	helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version 4.15.1 -n ingress-nginx --create-namespace --set controller.hostPort.enabled=true --set-string controller.nodeSelector.ingress-ready=true --set-string controller.tolerations[0].key=node-role.kubernetes.io/control-plane --set-string controller.tolerations[0].operator=Exists --set-string controller.tolerations[0].effect=NoSchedule --set controller.terminationGracePeriodSeconds=0
	$(MAKE) images
	kind load docker-image $(GATEWAY_IMG):$(GATEWAY_TAG) --name $(CLUSTER)
	kind load docker-image $(WOO_IMG):$(WOO_TAG) --name $(CLUSTER)
	kind load docker-image $(MOCK_IMG):$(MOCK_TAG) --name $(CLUSTER)
	kind load docker-image $(EVERYTHING_IMG):$(EVERYTHING_TAG) --name $(CLUSTER)
	kubectl create ns $(GW_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl create ns $(STORE_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl create ns $(UP_NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n $(GW_NS) get secret $(LLM_SECRET) >/dev/null 2>&1 || kubectl -n $(GW_NS) create secret generic $(LLM_SECRET) --from-literal=api-key=placeholder-change-me
	kubectl -n $(GW_NS) get secret $(LLM_FALLBACK_SECRET) >/dev/null 2>&1 || kubectl -n $(GW_NS) create secret generic $(LLM_FALLBACK_SECRET) --from-literal=api-key=placeholder-change-me
	helm upgrade --install $(STORE_RELEASE) ./charts/store -n $(STORE_NS)
	helm upgrade --install $(UP_RELEASE) ./charts/upstreams -n $(UP_NS)
	helm upgrade --install $(GW_RELEASE) ./charts/gateway -n $(GW_NS)
	kubectl -n $(GW_NS) wait --for=condition=available deploy/$(GW_RELEASE)-gateway --timeout=180s
	GW_NS="$(GW_NS)" STORE_NS="$(STORE_NS)" STORE_RELEASE="$(STORE_RELEASE)" GW_RELEASE="$(GW_RELEASE)" bash scripts/seed.sh

fonts: ## Fetch Switzer from Fontshare (FFL: self-host only, never committed)
	bash scripts/fetch-fonts.sh

images: ## Build the four service images locally
	@bash scripts/fetch-fonts.sh || echo "fonts: Switzer fetch failed; the dashboard falls back to system fonts"
	docker build -t $(GATEWAY_IMG):$(GATEWAY_TAG) -f apps/gateway/Dockerfile .
	docker build -t $(WOO_IMG):$(WOO_TAG) -f apps/woo-mcp/Dockerfile .
	docker build -t $(MOCK_IMG):$(MOCK_TAG) -f apps/mock-mcp/Dockerfile .
	docker build -t $(EVERYTHING_IMG):$(EVERYTHING_TAG) -f apps/everything-mcp/Dockerfile .

down: ## helm uninstall, keep data (PVCs/Secrets carry keep policy, D20)
	helm uninstall $(GW_RELEASE) -n $(GW_NS) || true
	helm uninstall $(UP_RELEASE) -n $(UP_NS) || true
	helm uninstall $(STORE_RELEASE) -n $(STORE_NS) || true

reset: ## Delete the kind cluster for a clean run (D19; dangerous: ask first)
	kind delete cluster --name urumi

secrets: ## Create the LLM key Secret (LLM_SECRET, default llm-opencode) via kubectl, never in values
	@if [ -z "$(LLM_API_KEY)" ]; then echo "set LLM_API_KEY=... (never commit it)"; exit 1; fi
	kubectl -n $(GW_NS) create secret generic $(LLM_SECRET) --from-literal=api-key="$(LLM_API_KEY)" --dry-run=client -o yaml | kubectl apply -f -

seed: ## Register woo, mock, everything via admin API (woo token read with kubectl, T3.6)
	bash scripts/seed.sh

test-netpol: ## Baseline+pair NetworkPolicy enforcement test (T1.1)
	bash scripts/test-netpol.sh

smoke: ## Live checks after a deploy (dashboard, auth, upstreams, storefront)
	bash scripts/smoke.sh

e2e: ## Product via /mcp, storefront COD order, order read back via /mcp
	bash scripts/e2e.sh

prod-up: export KUBECONFIG = $(PROD_KUBECONFIG)
prod-up: ## k3d cluster with values-prod.yaml; images retagged locally to GHCR names (not pushed)
	k3d cluster get $(PROD_CLUSTER) >/dev/null 2>&1 || k3d cluster create $(PROD_CLUSTER) -p "$(PROD_PORT):80@loadbalancer" -p "$(PROD_TLS_PORT):443@loadbalancer" --kubeconfig-switch-context=false --wait
	k3d kubeconfig write $(PROD_CLUSTER) >/dev/null
	$(MAKE) images
	for i in $(IMAGES); do docker tag $$i $(REGISTRY)/$$i; done
	k3d image import -c $(PROD_CLUSTER) $(addprefix $(REGISTRY)/,$(IMAGES))
	for n in $(GW_NS) $(STORE_NS) $(UP_NS); do kubectl create ns $$n --dry-run=client -o yaml | kubectl apply -f -; done
	kubectl -n $(GW_NS) get secret $(LLM_SECRET) >/dev/null 2>&1 || kubectl -n $(GW_NS) create secret generic $(LLM_SECRET) --from-literal=api-key=placeholder-change-me
	kubectl -n $(GW_NS) get secret $(LLM_FALLBACK_SECRET) >/dev/null 2>&1 || kubectl -n $(GW_NS) create secret generic $(LLM_FALLBACK_SECRET) --from-literal=api-key=placeholder-change-me
	# No --wait on the store: its post-install bootstrap creates the Secret woo-mcp needs.
	helm upgrade --install $(STORE_RELEASE) ./charts/store -n $(STORE_NS) -f charts/store/values-prod.yaml --set storeHost=$(PROD_SHOP) --set storeUrl=http://$(PROD_SHOP):$(PROD_PORT) --timeout 10m
	helm upgrade --install $(UP_RELEASE) ./charts/upstreams -n $(UP_NS) -f charts/upstreams/values-prod.yaml
	# The rehearsal is plain http, so the prod Secure cookie is turned off here (browsers drop it on http).
	helm upgrade --install $(GW_RELEASE) ./charts/gateway -n $(GW_NS) -f charts/gateway/values-prod.yaml --set appHost=$(PROD_APP) --set session.cookieSecure=false --wait --timeout 5m
	GW_NS="$(GW_NS)" STORE_NS="$(STORE_NS)" STORE_RELEASE="$(STORE_RELEASE)" GW_RELEASE="$(GW_RELEASE)" bash scripts/seed.sh

prod-check: export KUBECONFIG = $(PROD_KUBECONFIG)
prod-check: ## smoke + e2e against the k3d prod rehearsal
	APP_HOST=$(PROD_APP):$(PROD_PORT) SHOP_HOST=$(PROD_SHOP):$(PROD_PORT) bash scripts/smoke.sh
	APP_HOST=$(PROD_APP):$(PROD_PORT) SHOP_HOST=$(PROD_SHOP):$(PROD_PORT) bash scripts/e2e.sh

prod-down: ## Delete the k3d prod rehearsal cluster (dangerous: ask first)
	k3d cluster delete $(PROD_CLUSTER)
