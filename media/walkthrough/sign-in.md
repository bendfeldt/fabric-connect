# Sign in

Run **Fabric: Sign In** and enter your Entra **tenant ID** (a GUID — Entra
admin center → Overview). VS Code's Microsoft account provider opens the
browser sign-in and keeps the session in its secure storage.

- You can be signed in to several tenants; every request uses the tenant
  that owns what it touches, never another one.
- Fabric Connect never writes tokens to disk and never logs them.
