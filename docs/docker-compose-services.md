# Docker Compose Services

This document describes the services defined in the Docker Compose files and the
logging configuration applied to every service.

## Log Rotation

All services across `docker-compose.yml`, `docker-compose.prod.yml`, and
`docker-compose.staging.yml` use the `json-file` log driver with rotation limits
so that container logs cannot exhaust disk space on long-running instances.

Each service includes the following logging configuration:

```yaml
logging:
  driver: json-file
  options:
    tag: "backend"   # or "frontend"
```

Promtail reads from `/var/lib/docker/containers` and forwards structured JSON logs to Loki. Grafana dashboards query Loki using these tags.

---

## Staging Overlay

The staging override file (`docker-compose.staging.yml`) is layered on top of the base file:

The overlay replaces the RPC endpoint (`STAGING_RPC_URL`) and contract ID (`STAGING_CONTRACT_ID`) so the stack points at Stellar testnet rather than a local node. All service dependencies and health checks remain unchanged.

---
## Volumes

The logging configuration above is applied to every service in each compose file,
including the application, database, cache, and any auxiliary services. When
adding a new service, copy the `logging` block so rotation remains consistent.

## Verifying Configuration

After starting the stack, confirm the effective log settings for a container:

```sh
docker inspect --format '{{.HostConfig.LogConfig}}' <container_name>
```

The output should show the `json-file` driver with `max-size` and `max-file`
options matching the values above.
