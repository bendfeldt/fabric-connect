# Notebooks

Files from Fabric's git integration open in the Fabric notebook editor:

- `*.Notebook/notebook-content.py` (also `.scala`, `.sql`, `.r`)
- `*.Notebook/notebook-content.ipynb`

Pick the **Fabric Livy** kernel and run cells. They run on the notebook's
default Lakehouse, or on the connected compute when it has none — the
status bar shows which.

- `%run OtherNotebook {"param": 1}` runs a notebook **from this repo**.
- `%%sql`, `%%pyspark`, `%%spark`, `%%sparkr` switch the cell language.
- `display(df)` renders a table.

Saving writes the same file format Fabric uses; an unmodified notebook is
saved byte-for-byte.
