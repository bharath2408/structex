# create-structex

CLI for [Structex](https://github.com/bharath2408/structex) — structure for Express, without leaving Express behind.

Published on GitHub Packages. Add this to your `.npmrc` once (GitHub Packages requires it for scope resolution, and a [GitHub token](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) with `read:packages` for auth, even for public packages):

```
@bharath2408:registry=https://npm.pkg.github.com
```

## Create a project

```bash
npx @bharath2408/create-structex my-api
```

| Option | Default | |
|---|---|---|
| `--template <name>` | `modules` | `minimal` or `modules` |
| `--pm <manager>` | auto-detected | `npm`, `pnpm`, `yarn`, `bun` |
| `--no-install` | | skip dependency installation |
| `--no-git` | | skip `git init` |
| `--force` | | write into a non-empty directory |

**`modules`** — modules, DI container, a `CONFIG` token, and a service/controller split. Start here if the app will grow.

**`minimal`** — controllers registered directly with `registerControllers`, no container. Start here if you just want Express with tidier routes; you can move up later without rewriting controllers.

Both templates ship a working test suite, a central error handler, and `experimentalDecorators` already configured — including the esbuild setting Vitest needs, which is easy to miss.

## Generate code

```bash
npx structex g resource orders      # module + controller + service
npx structex g controller health
npx structex g service billing
npx structex g module admin
npx structex g guard admin --dir src/common --flat
npx structex g interceptor audit --dir src/common --flat
npx structex g pipe slug --dir src/common --flat
```

`generate` and `g` are equivalent.

| Option | |
|---|---|
| `--dir <path>` | target directory (default `src`) |
| `--flat` | write into `--dir` directly, no subfolder |
| `--force` | overwrite existing files |

`resource` and `module` create a subfolder (`src/orders/`); single files land directly in `src/`.

## Two deliberate choices

**Generators never overwrite without `--force`.** Existing files are skipped and reported. Clobbering your code is the one mistake a generator can't take back.

**Wiring is printed, not auto-edited.** After generating a resource the CLI tells you what to add to your root module rather than rewriting it. Editing a user's source by string manipulation is fragile, and a wrong edit is worse than a reminder.

## License

MIT
