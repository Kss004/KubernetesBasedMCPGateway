#!/usr/bin/env bash
# T1.1 NetworkPolicy enforcement test: baseline + pair (D2).
# Baseline (no policy): allowed AND denied pods must reach target (else invalid test).
# Then deny-all ingress + allow from role=allowed:
#   (a) allowed still connects; (b) denied is blocked.
# Outcomes: both hold = enforced; (b) fails = not enforced (recreate with Calico);
# (a) fails = allow rule mislabelled; baseline fails = invalid test.
# Distinguishes exec failure from request failure: exec errors abort (set -e),
# wget failures are captured per-pod and reported.
set -euo pipefail
NS=netpol-test
TARGET_IMG=nginx:1.29-alpine
CLIENT_IMG=busybox:1.36

kubectl delete ns "$NS" --ignore-not-found >/dev/null
kubectl create ns "$NS" >/dev/null
# Remove the scratch namespace however the script ends (KEEP_NS=1 keeps it for debugging).
[ "${KEEP_NS:-}" = 1 ] || trap 'kubectl delete ns "$NS" --ignore-not-found --wait=false >/dev/null' EXIT
for i in $(seq 1 30); do kubectl -n "$NS" get sa default >/dev/null 2>&1 && break || sleep 2; done
kubectl -n "$NS" create deploy target --image="$TARGET_IMG" >/dev/null
kubectl -n "$NS" expose deploy target --port=80 >/dev/null
kubectl -n "$NS" run allowed --image="$CLIENT_IMG" --labels=role=allowed --command -- sleep 3600 >/dev/null
kubectl -n "$NS" run denied --image="$CLIENT_IMG" --labels=role=denied --command -- sleep 3600 >/dev/null
kubectl -n "$NS" wait --for=condition=available deploy/target --timeout=180s >/dev/null
kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Running pod/allowed pod/denied --timeout=120s >/dev/null
sleep 5 # let nginx finish starting

probe() { # $1 = pod; prints OK or FAIL, never fails the script
  if kubectl -n "$NS" exec "$1" -- wget -q -T 5 -O /dev/null http://target 2>/dev/null; then echo OK; else echo FAIL; fi
}

echo "== baseline (no policy) =="
A0=$(probe allowed); D0=$(probe denied)
echo "allowed=$A0 denied=$D0"
[ "$A0" = OK ] && [ "$D0" = OK ] || { echo "BASELINE FAIL: invalid test (service/readiness/DNS?)"; exit 1; }

kubectl apply -n "$NS" -f - >/dev/null <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress
spec:
  podSelector: {}
  policyTypes: [Ingress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-allowed
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: allowed
YAML
sleep 5 # let the policy engine program the rules

echo "== with policies =="
A1=$(probe allowed); D1=$(probe denied)
echo "allowed=$A1 denied=$D1"
if [ "$A1" = OK ] && [ "$D1" = FAIL ]; then
  echo "ENFORCED: allowed connects, denied blocked"
else
  echo "NOT-ENFORCED (or mislabelled): see outcomes in T1.1"
  exit 2
fi
