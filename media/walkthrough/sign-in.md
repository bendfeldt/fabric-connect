# Sign in

Run **Fabric: Sign In**, pick your Microsoft account (or sign in with
another one in the browser), then pick the tenant. Your account's own
tenant is listed first, so Enter keeps it; for guest access, find the
tenants on your account or enter a tenant ID or domain.

- **Remembered per repo**, like a Tabular Editor `.tmuo` file: the account
  and tenant are saved in your gitignored `.fabric/local.json`, and
  reopening the repo signs you in again without a prompt.
- The **Fabric** icon in the Activity Bar shows the account and tenant
  under **Configuration**; its Tenant row switches the tenant.
- The status bar shows who the repo is signed in as. Click it to **switch
  account**, **switch tenant** (guest access to another organization) or
  **sign out**.
- Different repos can use different accounts and tenants side by side.
- Fabric Connect never writes tokens to disk and never logs them; they stay
  in VS Code's secure storage.
