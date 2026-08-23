# Quickstart

Everything below is copy-pasteable. Windows commands first, macOS/Linux after.

**Requires Node 18+.** Check with `node -v`.

---

## 1. Install and verify

Unzip somewhere without spaces or OneDrive sync if you can — `C:\dev\structex` is a good spot. OneDrive occasionally locks files mid-sync, which surfaces as `EPERM` or `EBUSY` during `npm install`.

```cmd
cd C:\dev\structex

npm install
npm run verify
```

`verify` runs typecheck, tests, and build for both packages. You should see **128 passing** for `structex` and **32 passing** for `create-structex`.

If that works, everything else will.

---

## 2. Run the examples

```cmd
cd packages\structex

npx tsx examples\basic.ts
```

Leave it running, open a second terminal:

```cmd
curl http://localhost:3000/api/v1/users/list
curl http://localhost:3000/api/v1/users/u_1
curl -N http://localhost:3000/api/v1/users/events
```

The last one is a server-sent-events stream — it prints an event per second for five seconds. Press `Ctrl+C` to stop.

The modules example shows DI, module encapsulation, and per-request scoping:

```cmd
npx tsx examples\modules.ts
```

```cmd
curl http://localhost:3001/api/users/u_1
curl http://localhost:3001/api/orders/mine -H "x-tenant: acme"
curl http://localhost:3001/api/orders/mine -H "x-tenant: globex"
```

Note the different tenant in each response — that's a fresh controller built per request.

---

## 3. Scaffold an app with the CLI

Neither package is published yet, so install from your local build rather than `npx @bharath2408/create-structex`.

```cmd
cd C:\dev\structex
npm run build

cd C:\dev
node "C:\dev\structex\packages\create-structex\dist\index.js" my-api --no-install

cd my-api
npm install
npm install "C:\dev\structex\packages\structex"
npm run dev
```

Then open <http://localhost:3000/api/users>.

That second `npm install` pointing at the package folder is the step people miss. The generated `package.json` depends on `@bharath2408/structex: ^0.5.0`, which does not exist on the registry yet, so it has to come from your local copy.

### Templates

```cmd
node "...\dist\index.js" my-api --template modules   REM default: DI + modules
node "...\dist\index.js" my-api --template minimal   REM plain controllers
```

Start with `minimal` if you want Express with tidier routes and no container. Moving up to `modules` later does not require rewriting controllers.

### Generators

From inside the generated project:

```cmd
npx structex g resource orders
npx structex g controller health
npx structex g guard admin --dir src/common --flat
```

Generators never overwrite an existing file without `--force`.

---

## macOS / Linux

Same steps, different paths:

```bash
cd ~/structex
npm install
npm run verify

# examples
cd packages/structex
npx tsx examples/basic.ts

# scaffold
cd ~/structex && npm run build
cd ~ && node ~/structex/packages/create-structex/dist/index.js my-api --no-install
cd my-api
npm install
npm install ~/structex/packages/structex
npm run dev
```

---

## Layout

```
structex/
  packages/
    structex/            the library
      src/               12 source files
      test/              128 tests
      examples/          two runnable servers
      scripts/           subpath shim generator
    create-structex/     the CLI
      src/               entry, templates, utils
      test/              32 tests
```

---

## When you publish

Both packages are scoped (`@bharath2408/structex`, `@bharath2408/create-structex`) and configured via `publishConfig.registry` to publish to **GitHub Packages**, not npmjs.org.

1. Create a GitHub personal access token with `write:packages` (and `read:packages`) scope.
2. Authenticate npm against GitHub Packages, e.g. add to `~/.npmrc`:
   ```
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN
   ```
3. Publish **`structex` first, then `create-structex`.** The CLI's templates pin `@bharath2408/structex@^0.5.0`, so the CLI generates broken projects until the library exists on the registry.

```bash
npm publish -w @bharath2408/structex
npm publish -w @bharath2408/create-structex
```

`prepublishOnly` runs typecheck, tests, and build automatically for both.

Note: GitHub Packages requires a GitHub token to *install* these too, even though they're public — there's no truly anonymous `npx @bharath2408/create-structex` the way there is with npmjs.org.

---

## Troubleshooting

**`Cannot find module` after unzipping** — run `npm install` at the repo root, not inside `packages/`. This is an npm workspaces monorepo; one install at the top covers both packages.

**`tsx` not found** — it comes from the root `npm install`. If you skipped that, run it.

**`experimentalDecorators` errors in your own project** — the setting must also reach whatever performs the TypeScript transform (esbuild, tsup, SWC, Vitest). See the Bundlers section of `packages/structex/README.md`. Scaffolded projects already have this configured.

**`EPERM` / `EBUSY` on Windows** — usually OneDrive or antivirus holding a file. Move the repo outside OneDrive.
