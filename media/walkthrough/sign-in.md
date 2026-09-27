# Sign in

Run **Fabric: Sign In** and pick your Microsoft account (or sign in with
another one in the browser). The repo is signed in to your account's
tenant — no tenant ID needed.

- **Remembered per repo**, like a Tabular Editor `.tmuo` file: the account
  and tenant are saved in your gitignored `.fabric/local.json`, and
  reopening the repo signs you in again without a prompt.
- The status bar shows who the repo is signed in as. Click it to **switch
  account**, **switch tenant** (guest access to another organization) or
  **sign out**.
- Different repos can use different accounts and tenants side by side.
- Fabric Connect never writes tokens to disk and never logs them; they stay
  in VS Code's secure storage.
