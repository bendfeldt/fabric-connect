# Query files

| File               | Runs against     |
| ------------------ | ---------------- |
| `.kql`, `.csl`     | a KQL database   |
| `.dax`             | a semantic model |
| `.graphql`, `.gql` | a GraphQL API    |

Open the file and run **Fabric: Run Query File**. The first time, pick the
workspace and item; the choice is remembered in `.fabric/local.json`.
**Fabric: Change Query Target** picks again. Results open as tables.

For T-SQL, copy a Lakehouse's or Warehouse's SQL connection string from the
Fabric view and use the Microsoft **mssql** extension.
