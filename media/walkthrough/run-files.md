# Run files and your own modules

- **Fabric: Run File on Fabric** (▷ in the editor title) runs a whole
  `.py`, `.sql`, `.scala` or `.r` file; **Run Selection** runs the
  selection. Output appears in the _Fabric Connect: Run_ output channel.
- **Fabric: Python Modules** picks where `import` finds your packages:
  **Local** stages your working tree (the folders `pyproject.toml` names,
  or `fabric-connect.sourceRoots`) before Python runs; **Remote** uses
  what the Fabric environment has installed, such as your wheel.
- Right-click a `*.SparkJobDefinition` folder → **Run Spark Job
  Definition** to run it as a Livy batch from local files.

Staged files go only to `Files/.fabric-connect/` in the host Lakehouse and
are removed when the session stops.
