---
title: "How to Deploy Sortie to Kubernetes"
linkTitle: "Deploy to Kubernetes"
description: "Deploy Sortie to a Kubernetes cluster with plain manifests: Deployment, PVC, ConfigMap, Service, Secrets, health probes, storage considerations, and production hardening."
keywords: sortie kubernetes, k8s, deploy, deployment, pod, PVC, SQLite, configmap, service, health probes, readiness, liveness, production, container orchestration
author: Sortie AI
date: 2026-04-07
weight: 190
url: /guides/deploy-sortie-to-kubernetes/
---
Run Sortie in a Kubernetes cluster using plain manifests — a Deployment, PersistentVolumeClaim, ConfigMap, Service, and Secret. Sortie uses SQLite for persistence, so deployments are limited to a single replica. The manifests enforce this constraint with a Recreate strategy and a ReadWriteOnce volume.

## Prerequisites

- A Kubernetes cluster (1.25+) with `kubectl` configured
- An agent-specific container image pushed to a registry your cluster can pull from ([how to build one](/guides/use-sortie-in-docker/))
- A tested `WORKFLOW.md` ([quick start](/getting-started/quick-start/))
- API credentials for your agent and tracker

## Build and push your image

Sortie's published image is distroless — it contains only the binary. Build an agent-specific image using one of the example Dockerfiles, then push it to your container registry:

```sh
docker build -f examples/docker/claude-code.Dockerfile -t registry.example.com/sortie-claude:v1.0.0 .
docker push registry.example.com/sortie-claude:v1.0.0
```

For image building details, see [How to use Sortie in Docker](/guides/use-sortie-in-docker/).

## Create the namespace and Secret

Store API keys in a Kubernetes Secret. Never put credentials in ConfigMaps or environment variable literals in manifests.

### Claude Code with Jira

```sh
kubectl create secret generic sortie-secrets \
    --from-literal=ANTHROPIC_API_KEY="sk-..." \
    --from-literal=SORTIE_JIRA_API_KEY="..." \
    --from-literal=SORTIE_JIRA_ENDPOINT="https://your-org.atlassian.net" \
    --from-literal=SORTIE_JIRA_PROJECT="PROJ"
```

### Claude Code with GitHub Issues

```sh
kubectl create secret generic sortie-secrets \
    --from-literal=ANTHROPIC_API_KEY="sk-..." \
    --from-literal=SORTIE_GITHUB_TOKEN="ghp_..." \
    --from-literal=SORTIE_GITHUB_PROJECT="owner/repo"
```

### Copilot with GitHub Issues

```sh
kubectl create secret generic sortie-secrets \
    --from-literal=GITHUB_TOKEN="ghp_..." \
    --from-literal=SORTIE_GITHUB_TOKEN="ghp_..." \
    --from-literal=SORTIE_GITHUB_PROJECT="owner/repo"
```

For tracker-specific credential details, see [How to connect to Jira](/guides/connect-to-jira/) or [How to connect to GitHub Issues](/guides/connect-to-github/).

## Write the workflow ConfigMap

The ConfigMap holds the `WORKFLOW.md` that Sortie loads at startup. Edit the `data` section to match your tracker and agent configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sortie-workflow
  labels:
    app.kubernetes.io/name: sortie
    app.kubernetes.io/component: orchestrator
    app.kubernetes.io/part-of: sortie
data:
  WORKFLOW.md: |
    ---
    tracker:
      kind: jira
      endpoint: $SORTIE_JIRA_ENDPOINT
      api_key: $SORTIE_JIRA_API_KEY
      project: $SORTIE_JIRA_PROJECT
      query_filter: "labels = 'agent-ready'"
      active_states:
        - To Do
        - In Progress
      in_progress_state: In Progress
      handoff_state: Human Review
      terminal_states:
        - Done
        - Won't Do

    polling:
      interval_ms: 45000

    db_path: /home/sortie/data/.sortie.db

    workspace:
      root: /home/sortie/data/workspaces

    agent:
      kind: claude-code
      command: claude
      max_concurrent_agents: 2

    server:
      port: 7678
    ---

    You are a senior engineer working on {{ .issue.identifier }}: {{ .issue.title }}

    {{ if .issue.description }}
    ## Description

    {{ .issue.description }}
    {{ end }}
```

Tracker credentials use `$VAR` syntax — Sortie expands environment variables at runtime from the Secret. The workflow file itself contains no sensitive values.

For the full list of configuration fields, see the [WORKFLOW.md configuration reference](/reference/workflow-config/). For prompt template syntax, see [How to write prompt templates](/guides/write-prompt-template/).

## Create the PersistentVolumeClaim

SQLite requires exclusive filesystem access. The PVC must use `ReadWriteOnce`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sortie-data
  labels:
    app.kubernetes.io/name: sortie
    app.kubernetes.io/component: orchestrator
    app.kubernetes.io/part-of: sortie
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

The 1Gi default is enough for months of run history and retry state. The SQLite database is small — a few megabytes even with thousands of completed sessions. The workspace root (where agents clone repos) lives inside this volume too, so increase the size if your repositories are large or you run many concurrent agents.

If your cluster has multiple storage classes, specify one explicitly:

```yaml
spec:
  storageClassName: standard-rwo
  accessModes:
    - ReadWriteOnce
```

For background on what Sortie persists and why it matters, see [Why persistence changes everything](/concepts/persistence/).

## Deploy the application

The Deployment runs a single replica with Recreate strategy. SQLite does not support concurrent writers, so scaling beyond one replica corrupts the database.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sortie
  labels:
    app.kubernetes.io/name: sortie
    app.kubernetes.io/component: orchestrator
    app.kubernetes.io/part-of: sortie
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: sortie
  template:
    metadata:
      labels:
        app.kubernetes.io/name: sortie
        app.kubernetes.io/component: orchestrator
        app.kubernetes.io/part-of: sortie
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: sortie
          image: registry.example.com/sortie-claude:v1.0.0
          args:
            - "--host"
            - "0.0.0.0"
            - "--log-format"
            - "json"
            - "/home/sortie/config/WORKFLOW.md"
          env:
            - name: SORTIE_DB_PATH
              value: /home/sortie/data/.sortie.db
          ports:
            - name: http
              containerPort: 7678
              protocol: TCP
          envFrom:
            - secretRef:
                name: sortie-secrets
                optional: false
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          startupProbe:
            httpGet:
              path: /readyz
              port: http
            failureThreshold: 30
            periodSeconds: 2
          livenessProbe:
            httpGet:
              path: /livez
              port: http
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          volumeMounts:
            - name: data
              mountPath: /home/sortie/data
            - name: workflow
              mountPath: /home/sortie/config
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: sortie-data
        - name: workflow
          configMap:
            name: sortie-workflow
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
```

Key decisions in this manifest:

| Setting | Rationale |
|---|---|
| `replicas: 1` / `Recreate` | SQLite requires exclusive access — no rolling updates, no concurrent pods |
| `runAsNonRoot` / UID 1000 | Matches the `sortie` user created in agent Dockerfiles. Claude Code refuses to run as root. |
| `readOnlyRootFilesystem` | Write access is restricted to the PVC mount and `/tmp`. Limits the blast radius if the container is compromised. |
| `fsGroup: 1000` | Kubernetes sets group ownership on the PVC to match, so the non-root user can write to it |
| `--host 0.0.0.0` | Binds the HTTP server to all interfaces so probes and the Service can reach it |
| `--log-format json` | Produces newline-delimited JSON for log aggregation. See [How to monitor with logs](/guides/monitor-with-logs/). |
| `SORTIE_DB_PATH` env var | Configures the SQLite database path on the PVC. Also set via `db_path` in the workflow. |
| `/tmp` emptyDir | Some agent subprocesses and Go's `os.CreateTemp` need a writable temp directory |

Replace `registry.example.com/sortie-claude:v1.0.0` with your actual image reference.

## Expose the Service

A ClusterIP Service exposes the HTTP observability server within the cluster:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: sortie
  labels:
    app.kubernetes.io/name: sortie
    app.kubernetes.io/component: orchestrator
    app.kubernetes.io/part-of: sortie
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: sortie
    app.kubernetes.io/component: orchestrator
  ports:
    - name: http
      port: 7678
      targetPort: http
      protocol: TCP
```

This Service gives in-cluster access to the [HTML dashboard](/reference/dashboard/), [JSON API](/reference/http-api/), [Prometheus metrics](/reference/prometheus-metrics/), and health probes. To expose the dashboard externally, add an Ingress or LoadBalancer in front of it.

## Apply the manifests

Apply everything at once from the example directory:

```sh
kubectl apply -f examples/k8s/
```

Or apply each manifest individually in order:

```sh
kubectl apply -f examples/k8s/pvc.yaml
kubectl apply -f examples/k8s/configmap.yaml
kubectl apply -f examples/k8s/deployment.yaml
kubectl apply -f examples/k8s/service.yaml
```

## Verify the deployment

Check that the pod starts and passes health probes:

```sh
kubectl get pods -l app.kubernetes.io/name=sortie
```

Expected output:

```
NAME                      READY   STATUS    RESTARTS   AGE
sortie-7b4f9c6d88-x2k4p  1/1     Running   0          45s
```

Inspect the startup logs:

```sh
kubectl logs -l app.kubernetes.io/name=sortie --tail=20
```

Confirm the readiness probe is passing:

```sh
kubectl get endpoints sortie
```

If the `ENDPOINTS` column shows an IP address, the pod is ready and the Service is routing traffic.

Port-forward to access the dashboard from your workstation:

```sh
kubectl port-forward svc/sortie 7678:7678
```

Open `http://localhost:7678` to view the [dashboard](/reference/dashboard/), or query the API:

```sh
curl -s http://localhost:7678/api/status | jq .
```

## Update the workflow

To change the workflow without rebuilding the image, edit the ConfigMap:

```sh
kubectl edit configmap sortie-workflow
```

Kubernetes propagates ConfigMap changes to the mounted volume within the kubelet sync period (typically under 60 seconds). Because the ConfigMap is mounted as a directory (not via `subPath`), updates reach the container filesystem automatically.

Sortie's file watcher may not detect the Kubernetes symlink-swap mechanism that delivers these updates. If the new configuration is not picked up automatically, restart the pod:

```sh
kubectl rollout restart deployment sortie
```

## Handle restarts and persistence

Sortie stores all durable state — retry queues, run history, session metadata, token counters — in SQLite on the PVC. When Kubernetes reschedules the pod (node drain, OOM kill, manual restart), the new pod mounts the same volume and resumes from the last committed transaction.

Test this by deleting the pod:

```sh
kubectl delete pod -l app.kubernetes.io/name=sortie
```

The Deployment controller recreates it. Check the logs for a warm-start message indicating that existing state was loaded. In-flight agent sessions that were interrupted are marked as timed-out and retried according to your [retry configuration](/guides/configure-retry-behavior/).

For a deeper look at what Sortie preserves across restarts, see [How to resume sessions across restarts](/guides/resume-sessions-across-restarts/).

## Monitor the deployment

### Prometheus

If you run Prometheus in the cluster, add a scrape target or ServiceMonitor for the `sortie` Service on port 7678 at the `/metrics` endpoint. See [How to monitor with Prometheus](/guides/monitor-with-prometheus/) for PromQL queries and a Grafana dashboard.

### Logs

JSON-formatted logs integrate with any Kubernetes log aggregation stack — Loki, Datadog, CloudWatch, ELK. Filter by structured fields like `issue_id`, `session_id`, or `level`:

```sh
kubectl logs -l app.kubernetes.io/name=sortie | jq 'select(.level == "ERROR")'
```

See [How to monitor with logs](/guides/monitor-with-logs/) for field descriptions and grep/jq patterns.

## Production considerations

### Resource limits

The default requests (100m CPU, 256Mi memory) and limits (500m CPU, 512Mi memory) are starting points. Sortie itself is lightweight, but agent subprocesses (Claude Code, Copilot) consume resources too. Monitor actual usage with `kubectl top pod` and adjust:

```yaml
resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 2Gi
```

### Storage sizing

The SQLite database grows slowly — a few megabytes per thousand completed sessions. The workspace root consumes more because it holds cloned repositories. Size the PVC based on the number of concurrent agents and the size of your repositories:

| Scenario | Recommended PVC size |
|---|---|
| 1–2 agents, small repos (< 100 MB each) | 1Gi |
| 2–5 agents, medium repos (100–500 MB each) | 5Gi |
| 5+ agents, large repos or monorepos | 10Gi+ |

### Node affinity

The PVC uses `ReadWriteOnce`, which binds it to a single node. If the node goes down, the pod cannot reschedule until the volume detaches. For faster recovery, use a storage class that supports node-independent access (e.g., network-attached block storage like EBS, Persistent Disk, or Ceph RBD).

### Security

The Deployment manifest follows Kubernetes pod security hardening guidelines:

- Runs as non-root with a fixed UID/GID
- Drops all Linux capabilities
- Uses a read-only root filesystem
- Applies a `RuntimeDefault` seccomp profile

If your cluster enforces Pod Security Standards, the manifest complies with the `restricted` profile. See [Security model](/concepts/security/) for Sortie's workspace isolation guarantees.

### Graceful shutdown

Sortie handles `SIGTERM` for graceful shutdown. The `terminationGracePeriodSeconds: 30` gives in-flight agent sessions time to checkpoint before the pod is killed. If your agent sessions are long-running, increase this value to avoid unnecessary retries.

## Troubleshooting

**Pod stays in `Pending` state:** The PVC cannot be bound. Check that your cluster has a default storage class or that the PVC specifies one explicitly. Run `kubectl describe pvc sortie-data` to see the binding status.

**Pod starts but crashes with `CrashLoopBackOff`:** Inspect logs with `kubectl logs -l app.kubernetes.io/name=sortie --previous`. Common causes: missing Secret (check `kubectl get secret sortie-secrets`), invalid WORKFLOW.md syntax (test locally with `sortie validate WORKFLOW.md`), or wrong image reference.

**Readiness probe fails:** Sortie's `/readyz` endpoint returns HTTP 503 if any subsystem is unhealthy — database, workflow validation, or preflight checks. Port-forward and query the endpoint directly to see the per-subsystem status:

```sh
kubectl port-forward svc/sortie 7678:7678
curl -s http://localhost:7678/readyz | jq .
```

**Permission denied on the data volume:** The `fsGroup: 1000` setting should handle ownership, but some storage drivers ignore it. Verify with:

```sh
kubectl exec -it deploy/sortie -- ls -la /home/sortie/data
```

If the directory is owned by root, your storage class may not support `fsGroup`. Add an init container to fix permissions:

```yaml
initContainers:
  - name: fix-permissions
    image: busybox:1.36
    command: ["sh", "-c", "chown -R 1000:1000 /home/sortie/data"]
    volumeMounts:
      - name: data
        mountPath: /home/sortie/data
    securityContext:
      runAsUser: 0
```

**SQLite database locked after crash:** This can happen if the pod was killed without a graceful shutdown and the WAL file was not checkpointed. The next startup recovers automatically — SQLite replays the WAL on open. If the pod still fails, delete the `-wal` and `-shm` files from the data volume (Sortie recreates them):

```sh
kubectl exec -it deploy/sortie -- rm -f /home/sortie/data/.sortie.db-wal /home/sortie/data/.sortie.db-shm
```

## Reference manifests

The Sortie repository maintains reference manifests that track the latest proven configuration:

| File | Description |
|---|---|
| [`deployment.yaml`](https://github.com/sortie-ai/sortie/blob/main/examples/k8s/deployment.yaml) | Single-replica Deployment with Recreate strategy |
| [`configmap.yaml`](https://github.com/sortie-ai/sortie/blob/main/examples/k8s/configmap.yaml) | Sample WORKFLOW.md mounted into the container |
| [`service.yaml`](https://github.com/sortie-ai/sortie/blob/main/examples/k8s/service.yaml) | ClusterIP Service exposing port 7678 |
| [`pvc.yaml`](https://github.com/sortie-ai/sortie/blob/main/examples/k8s/pvc.yaml) | 1Gi ReadWriteOnce PVC for the SQLite database |
