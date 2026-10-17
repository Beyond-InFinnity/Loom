# Extension checks

From the repository root, use the Node version in `.nvmrc`:

```sh
nvm use
npm ci
npm --workspace apps/extension exec -- wxt prepare
npm --workspace apps/extension run compile
npm exec -- tsc -p packages/player-ui/tsconfig.json
npm exec -- tsc --noEmit -p apps/desktop/tsconfig.json
npm --workspace apps/extension test -- --maxWorkers=2
node --test scripts/check-extension-manifest.test.mjs
npm exec --workspace packages/api-client -- openapi-typescript openapi.json -o src/types.ts
git diff --exit-code -- packages/api-client/src/types.ts
unset LOOM_API_BASE
npm --workspace apps/extension run build:firefox:prod
node scripts/check-extension-manifest.mjs firefox
npm --workspace apps/extension run build:chrome:prod
node scripts/check-extension-manifest.mjs chrome
```

The JavaScript CI job runs these checks for pushes and PRs targeting `main`
or `monorepo-restructure`. The API check uses the **committed** OpenAPI schema;
it does not start or contact a server, regenerate that schema, or establish
that production implements every schema route.

The manifest snapshots cover the complete production manifests, excluding
only `version`. The actual version must still match the extension package.
Object key order is irrelevant; array ordering and all fields are retained.
An intentional permission, host, content-script, consent or identity change
must include a reviewed snapshot diff. Do not refresh snapshots automatically
in CI. Firefox's minimum version is 140.0 to match its existing built-in
data-consent declaration; this means older Firefox versions cannot install
the next build. See [Mozilla's consent documentation](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

For a negative control, build with `LOOM_API_BASE=http://localhost:8000`
and run the manifest checker: it must fail. The development override remains
available for diagnosis; it must not pass as the release artifact. The guard's
tests also mutate privileges, execution worlds and unexpected manifest fields.

These checks do not certify live streaming-site behavior or store readiness.
The 0.5.2 caption lifecycle/cache regression work and browser smoke checks
remain separate. No store upload or backend deployment is part of this job.
