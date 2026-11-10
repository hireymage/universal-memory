# Security

Keep vault contents and tokens out of issue reports. The service executes no Markdown and follows no symlinks during scans. Use loopback binding for local deployments. Remote deployment requires bearer authentication, explicit allowed origins/hosts at the reverse proxy, and TLS.

The simple static bearer token is suitable for a single-user private deployment. Multi-user or internet-facing deployments should replace it with the official MCP OAuth resource-server flow and scoped authorization.

Before enabling writes on an existing vault, make a filesystem backup and complete the documented inspection workflow.
