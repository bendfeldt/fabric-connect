# Run files and your own modules

- **Fabric: Run File on Fabric** (▷ in the editor title) runs a whole
  `.py`, `.sql`, `.scala` or `.r` file; **Run Selection** runs the
  selection. Output appears in the _Fabric Connect: Run_ output channel.
- Set **`fabric-connect.sourceRoots`** (e.g. `["src"]`). Before Python
  runs, those folders' `.py` files are staged to the session, so
  `import mypkg` uses the code in your working tree.
- Right-click a `*.SparkJobDefinition` folder → **Run Spark Job
  Definition** to run it as a Livy batch from local files.

Staged files go only to `Files/.fabric-connect/` in the host Lakehouse and
are removed when the session stops.
