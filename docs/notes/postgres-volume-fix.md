# 2026-10-13: gateway postgres lost all tables — root cause + fix

- Symptom: `/api/servers` → `relation "servers" does not exist`, DB otherwise
  healthy. Fresh `initdb` + `CREATE DATABASE` in pg logs at 11:01 (node reboot).
- Root cause: chart mounted the PVC at `/var/lib/postgresql` (the PARENT of
  PGDATA). The stock image declares `VOLUME /var/lib/postgresql/data`, so the
  pod had TWO mounts there (`/proc/mounts` proved it) and postgres wrote to
  the ephemeral image-volume mount. The PVC held only a stale empty `data/`
  dir since Oct 9. First container restart → overlay wiped → initdb fresh.
  MariaDB (`/var/lib/mysql`) and WordPress (`/var/www/html`) mount exactly on
  their image VOLUMEs — single mount each, data intact. That's why only
  postgres lost data.
- Fix: mount the PVC directly at `/var/lib/postgresql/data` (standard
  pattern), cleared the stale dir once, re-ran `make seed` + re-registered
  mock. Regression test: deleted the postgres pod → both servers still
  listed and Connected. Rule: a volumeMount must cover the image's VOLUME,
  never its parent — check `/proc/mounts` for double-mounts when in doubt.
