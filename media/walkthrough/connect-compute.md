# Connect to compute

**Fabric: Connect to Compute** is the Databricks Connect moment: you pick,
once per repo, the **capacity** your code runs on — SKU, region and state
appear when you have capacity permissions (known paused ones are refused).
Nothing else is asked.

Notebooks with a default Lakehouse or local binding run in that Lakehouse's
own workspace; selecting a capacity does not relocate it. Code without a Lakehouse of
its own (a plain `.py` file, a notebook with no default) asks once for a
**host Lakehouse** on that capacity — Spark sessions run there, and
relative paths like `Files/…` resolve there — and optionally an
**Environment**.

The choice is saved under `"compute"` in `.fabric/local.json`. Keep that
file out of git — it names client capacities and workspaces.

Fabric Connect **never creates items**, Lakehouses included. If no
workspace on the capacity has a Lakehouse, create one in the Fabric portal
first.
