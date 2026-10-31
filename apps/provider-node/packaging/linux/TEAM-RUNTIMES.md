# Team worker service instances

The template `1dayapi-team@.service` runs one upstream organization UUID per
instance on a shared host. `PROVIDER_TEAM_ID` pins that instance to exactly that
organization. Its hello advertises the pin, and both the platform registry and
the node reject another team's account or proxy. Protocol capability
`team_isolation_v1` is mandatory for isolated traffic; old nodes are ineligible.

Each instance has a distinct systemd `DynamicUser`, `StateDirectory`, node
identity/config/encryption key, worker root and private temporary directory.
Binding and deployment must create **a separate platform node record for each
instance**, associate that team's fixed proxy pool with it, and use a distinct
local console port via `PROVIDER_CONSOLE_PORT`.
The Claude binary must be installed at a host-readable, system-wide location;
a binary inside `/root` will not work with `ProtectHome=yes`.

Install the template under `/etc/systemd/system`, provision each instance's
binding config and environment, then start `1dayapi-team@<orgUuid>.service`.
The `ExecStart` Bun path, `CC_WORKER_CLAUDE_BIN` and console port must match the
host. Existing shared node identities, account directories and device identities
must not be copied into another team's state directory.

Actual rollout status is recorded in
[`docs/deployment/team-isolation-2026-10-27.md`](../../../../docs/deployment/team-isolation-2026-10-27.md).
Updating a node bundle does not by itself install this template, create dedicated
OS service users or migrate existing accounts. The deployment must report these
as separate actions.

For the 2026-10-27 rollout, the host-specific bundle template was installed, but
zero dedicated team instances were started because the new team registry was
empty. The three upgraded standard workers remain shared service instances
with protocol and state isolation. Their preserved original config files and
new per-release config/worker directories are listed in the release record.

This isolates OS identities and writable state on one host. It still shares the
host kernel and hardware. Dedicated VMs/hosts are required to separate those as
well. Do not enable `CC_WORKER_MACHINE_IDENTITY` in this template: `DynamicUser`
and `NoNewPrivileges=yes` intentionally prevent the root mount-namespace setup
used by that mode. If `PROVIDER_TEAM_ID` is unset, a node can host multiple teams with checked
protocol ownership and namespaced process/config state, but it is **not** an OS
isolation boundary; do not describe that mode as physically isolated.

A forced conversation reset revokes only the retired conversation generation:
queued opens are removed, in-flight egress is aborted, persistent worker process
groups and parked MCP calls are destroyed, and delayed frames are fenced by the
platform's durable generation check. Account credentials, device identity and
fixed proxy bindings remain with their original organization.

Only nodes that executed the retired generation participate in teardown
acknowledgement. If an old runtime does not acknowledge, its connection is
withdrawn and its reset debt is replayed on reconnect. It cannot delay unrelated
team runtimes; a new team proceeds after the old generation's I/O is fenced.
