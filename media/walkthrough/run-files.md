# Run files and your own modules

- **Fabric: Run File on Fabric** (▷ in the editor title) runs a whole
  `.py`, `.sql`, `.scala` or `.r` file; **Run Selection** runs the
  selection. Output appears in the _Fabric Connect: Run_ output channel.
- **Fabric: Python Modules (Local or Remote)** picks where `import` finds your packages:
  **Local** stages your working tree (the folders `pyproject.toml` names,
  or `fabric-connect.sourceRoots`, else `src`) before Python runs; **Remote** uses
  what the Fabric environment has installed, such as your wheel.
  `auto` chooses Local only when explicit source roots are non-empty.
  Restart after switching from Local to Remote to discard staged imports.
- Right-click a `*.SparkJobDefinition` folder → **Run Spark Job
  Definition** to run it as a Livy batch from local files.

Staged files go only to `Files/.fabric-connect/` in the host Lakehouse and
cleanup is attempted for this window's directory on stop/restart. It is best
effort; idle expiry does not guarantee deletion.
