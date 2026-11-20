# Remote Ollama

Configure an explicitly selected Ollama endpoint in the resource settings. Buro does not need SSH for an Ollama API connection.

Use a machine name or address supplied by the operator, such as `http://ollama-host.local:11434`, and explicitly select private-network trust for a LAN endpoint. Keep the API restricted to the intended clients: network access to Ollama must not be made public.

Choose an installed model and context size that fit the available GPU and system memory. Record the actual model, context, and CPU offload when measuring results. Hardware availability and successful diagnostics do not prove coding quality.

Validate fully local and explicitly permitted mixed profiles separately with the same synthetic task, service-owned checks, and a fresh independent reviewer. A mixed profile may send context to a remote provider and requires an appropriate data grant.

Machine addresses, firewall scopes, host configuration, and private-project evaluation records are kept outside this repository. See [evaluation](EVALUATION.md) and [resources](RESOURCES.md).
