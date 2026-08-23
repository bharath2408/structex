# structex

**Structure for Express — without leaving Express behind.**

```bash
npx create-structex my-api
```

| Package | Description |
|---|---|
| [`structex`](packages/structex) | The library. Controllers, DI, modules, interceptors, SSE, OpenAPI. Zero runtime dependencies. |
| [`create-structex`](packages/create-structex) | The CLI. Scaffolds projects and generates code. |

## Why not just NestJS?

Nest is excellent and has an ecosystem this doesn't. The cost of adopting it is that you stop writing Express: middleware becomes interceptors and pipes, `req`/`res` disappear behind an abstraction, and your existing knowledge stops transferring.

Structex keeps Express in front of you. `app.use()` works, middleware is still `RequestHandler`, `@Res()` gives you the real response. You get organized code without a new mental model.

**Use NestJS instead** if you'll want `@nestjs/swagger`, TypeORM integration, or microservice transports within six months.

## Development

```bash
npm install
npm run verify      # typecheck + test + build, both packages
```

## License

MIT
