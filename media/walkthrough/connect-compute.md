# Connect to compute

**Fabric: Connect to Compute** is the Databricks Connect moment: you pick,
once per repo,

1. a **capacity** — shown with its SKU and region (paused ones are refused),
2. a **workspace** on that capacity,
3. an existing **host Lakehouse** — Spark sessions run here, and relative
   paths like `Files/…` resolve here,
4. optionally an **Environment** (libraries, Spark settings).

The choice is saved under `"compute"` in `.fabric/local.json`. Keep that
file out of git — it names client capacities and workspaces.

Fabric Connect **never creates items**, Lakehouses included. If the
workspace has no Lakehouse, create one in the Fabric portal first.
