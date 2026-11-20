# Select an execution host

Run **Fabric: Select Execution Host…** and pick the workspace and Lakehouse
that host code without a Lakehouse of its own, plus an optional
**Environment**. Capacity name, SKU and state are derived from the workspace;
known paused capacities are refused.

Notebooks with a default Lakehouse or local binding run there without this
host. Plain files and notebooks without a default reuse the selected host;
relative paths like `Files/…` resolve there.

The choice is saved under the compatibility key `"compute"` in
`.fabric/local.json`. Keep that file out of git — it names client capacities
and workspaces.

Fabric Connect **never creates items**, Lakehouses included. If the selected
workspace has no Lakehouse, create one in the Fabric portal first.
