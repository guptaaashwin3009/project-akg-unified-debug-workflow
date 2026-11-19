# akg-debug

`akg-debug` is a local CLI for investigating a service failure. It reads Datadog logs and Kubernetes logs, correlates them with a checkout on your machine, asks a model for one structured diagnosis, and can open a GitHub pull request. A later command deploys only by dispatching a GitHub Actions workflow that already exists in that service repo.

Secrets stay on your machine. Team defaults live in the service repo as an optional `.akg-debug.yml`. This repository ships [`.akg-debug.example.yml`](.akg-debug.example.yml) so you can copy it into a service repo. You do not need a real `.akg-debug.yml` here.

Investigate is read-only against Datadog and the cluster. The CLI never runs `kubectl apply`, never merges the pull request, never force-pushes, and never changes git config.

## Install

Node.js 20 or newer:

```bash
npm install
npm run build
node dist/cli.js --help
```

The package `bin` is `akg-debug`. After `npm link`, or when this package is installed, `npx akg-debug --help` runs the same command.

## Auth once

Credentials are asked for only when a command needs them. Non-interactive runs do not prompt. If a secret is missing and stdin is not a terminal, the command exits and names the `akg-debug auth ...` command to run.

Datadog keys, the model key, and the remembered Kubernetes context name are stored in `~/.config/akg-debug/credentials.json` with mode `0600`. The file is never printed. Kubernetes kubeconfig is not copied. GitHub auth stays in `gh`.

```bash
akg-debug auth datadog
akg-debug auth llm
akg-debug auth github
akg-debug auth status
```

- **Datadog.** API key, application key, and site. The default site is `datadoghq.com`. Keys are checked with `GET https://api.<site>/api/v1/validate`. A 401 or 403 asks for the keys again and replaces the stored ones.
- **Model.** One OpenAI-compatible API key and base URL. The default base URL is `https://api.openai.com/v1`. Set `AKG_DEBUG_MODEL` to override the model name (default `gpt-4o-mini`). Diagnosis is one chat completion that must return JSON.
- **GitHub.** Requires `gh auth status`. If that fails, the CLI starts `gh auth login` once.
- **Kubernetes.** Uses the current `kubectl` context. `akg-debug auth status` prints that context name when it has been recorded. If the cluster rejects the call, log in the way you usually do and run the command again.

`akg-debug auth status` prints `configured` or `missing` for Datadog, GitHub, and the model. It prints the kube context name, or `missing`.

## Team config

Copy `.akg-debug.example.yml` to the service repo as `.akg-debug.yml`. Flags override the file. A repo with no file still works when you pass `--service`, `--namespace`, and `--query`.

```yaml
service: payments-api
datadog:
  query: service:payments-api env:prod
k8s:
  namespace: payments
  selector: app=payments-api
github:
  deployWorkflow: deploy.yml
  deployRef: main
  workflowInputs:
    environment: prod
patch:
  allow:
    - "src/**"
    - "test/**"
```

`github.deployRef`, `github.workflowInputs`, and `patch.allow` are optional. The label selector defaults to `app=<service>`. `patch.allow` defaults to every file in the repo except `.git`, absolute paths, and paths that contain `..`.

## Investigate

```bash
akg-debug investigate --repo ~/src/payments-api --since 1h
akg-debug investigate --service payments-api --namespace payments --query "service:payments-api"
akg-debug investigate --yes
```

`--since` defaults to `1h`. Values such as `30m`, `1h`, and `2d` are accepted. `--repo` defaults to the current directory and must be inside a git checkout.

The command searches Datadog (`status:error` is added when the query does not already mention status), then runs read-only `kubectl get pods`, `kubectl logs`, and `kubectl get events`. It fingerprints repeated errors, maps JavaScript, TypeScript, Python, and Go stack frames onto repo files, and reads short excerpts. The model returns a summary, evidence, confidence, root cause, unified diff, test plan, and deploy notes.

That diagnosis and the diff are printed before any git write. The diff is rejected when it leaves the repo, touches `.git`, uses an absolute path, uses `..`, or sits outside `patch.allow`. `git apply --check` runs before the branch is created. If the check fails, the model is called once more with the error. A second failure exits non-zero and leaves the tree unchanged. The run is still saved.

When the diff is safe, the CLI asks `Open a pull request with this fix?`. `--yes` skips that question. A declined prompt still saves the run and does not create a branch. An accepted prompt creates `akg-debug/<run-id>`, commits the diagnosis summary, pushes it, and runs `gh pr create`.

Runs are stored at `~/.config/akg-debug/runs/<id>.json` with mode `0600`.

```bash
akg-debug runs
```

## Deploy

Deploy does nothing until you confirm. The interactive question includes the service name. `--approve` is the non-interactive confirmation.

```bash
akg-debug deploy <run-id>
akg-debug deploy <run-id> --approve
akg-debug deploy <run-id> --approve --ignore-checks
```

The run must have a pull request URL. `gh pr checks` must be passing unless you also pass `--ignore-checks`. Pending or failing checks stop the command when that flag is absent. `--approve --ignore-checks` is the explicit non-interactive override. Without `--approve`, ignoring checks asks a second time.

The dispatch is `gh workflow run <github.deployWorkflow> --ref <ref>` with `-f key=value` from `github.workflowInputs`. The ref is `github.deployRef` when set, otherwise the pull request head branch. If `.github/workflows/<deployWorkflow>` is not in the target repo, the command stops. It does not merge the pull request and it does not change the cluster itself.

## Tests

```bash
npm test
```

The tests cover fingerprinting, stack mapping, diff path safety, the `0600` credential file, and `--since` parsing. They do not call Datadog, kubectl, GitHub, or a model.
