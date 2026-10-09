# Notebooks

Files from Fabric's git integration open in the Fabric notebook editor:

- `*.Notebook/notebook-content.py` (also `.scala`, `.sql`, `.r`)
- `*.Notebook/notebook-content.ipynb`

Pick the **Fabric Livy** kernel and run cells. They run on the notebook's
default Lakehouse/local binding, or on the compute host when it has none — the
status bar shows which.

- A git-synced default marked _not bound_ needs **Bind Lakehouse…**.
  This stores a per-notebook binding in gitignored `.fabric/local.json`,
  leaving the notebook unchanged. Attach/Set as Default edits its metadata.
- **Open as Text** (notebook toolbar) shows the raw file, with **Run Cell**
  above each source-format cell (`.py`, `.scala`, `.sql`, `.r`).
  An `.ipynb` text view is JSON, not source-cell code lenses.
  **Open Changes as Text** (right-click in Source
  Control) shows the raw diff, metadata included.
- `%run OtherNotebook {"param": 1}` runs a notebook **from this repo**.
- `%%sql`, `%%pyspark`, `%%spark`, `%%sparkr` switch the cell language.
- `display(df)` renders a table.

Saving writes the same file format Fabric uses; an unmodified notebook is
saved byte-for-byte.
