{{/* Public store URL: WP_HOME, WP_SITEURL, install URL and woo-mcp signing base. Set storeUrl for https or a non-80 port; the Ingress host stays storeHost. */}}
{{- define "store.url" -}}
{{- .Values.storeUrl | default (printf "http://%s" .Values.storeHost) -}}
{{- end -}}
