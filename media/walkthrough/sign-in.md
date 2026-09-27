# Sign in

Run **Fabric: Sign In** and select your tenant: pick a recent one, choose
**Find tenants on my account…** to list them all by name, or enter a
tenant ID or domain (e.g. `contoso.onmicrosoft.com`). VS Code's Microsoft
account provider opens the browser sign-in and keeps the session in its
secure storage.

- Run **Fabric: Sign In** again any time to switch tenant; the Fabric
  explorer follows the tenant you select.
- You can be signed in to several tenants; every request uses the tenant
  that owns what it touches, never another one.
- Fabric Connect never writes tokens to disk and never logs them.
