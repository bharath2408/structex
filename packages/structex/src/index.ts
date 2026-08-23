/* Decorators */
export {
  Controller,
  Route,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Head,
  Sse,
  HttpCode,
  Header,
  Redirect,
  Version,
  UseGuards,
  UseInterceptors,
  ApiDoc,
  Body,
  Param,
  Query,
  Headers,
  Cookies,
  UploadedFile,
  UploadedFiles,
  Req,
  Res,
  Next,
  Ip,
  createParamDecorator,
  type ParamDecoratorFactory,
} from "./decorators.js";

/* Registration */
export {
  registerControllers,
  listRoutes,
  printRoutes,
  joinPaths,
  scoped,
  type Ctor,
  type ControllerInput,
  type ScopedController,
  type RegisterOptions,
  type RouteInfo,
  type TransformContext,
} from "./register.js";

/* Responses */
export {
  respond,
  isResponseEnvelope,
  formatSseEvent,
  type RespondInit,
  type ResponseEnvelope,
  type RedirectResult,
  type SseEvent,
  type SseStream,
} from "./response.js";

/* Serialization */
export {
  Exclude,
  Expose,
  Transform,
  serialize,
  resolveRules,
  resolveGroups,
  type ExposeOptions,
  type FieldRule,
  type SerializeContext,
  type SerializeGroups,
} from "./serialization.js";

/* Errors */
export {
  createErrorHandler,
  type ErrorHandlerOptions,
} from "./error-handler.js";
export {
  HttpError,
  isHttpError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  UnprocessableEntity,
  TooManyRequests,
  InternalServerError,
} from "./errors.js";

/* Pipes */
export {
  required,
  defaultTo,
  trim,
  toNumber,
  toInt,
  toBoolean,
  clamp,
  oneOf,
  parseWith,
} from "./pipes.js";

/* Interceptors */
export {
  timing,
  timeout,
  cache,
  rateLimit,
  retry,
  envelope,
  type CacheOptions,
  type RateLimitOptions,
  type RetryOptions,
} from "./interceptors.js";

/* OpenAPI */
export {
  toOpenApi,
  toOpenApiPath,
  swaggerUiHtml,
  type OpenApiInfo,
  type OpenApiOptions,
  type SwaggerUiOptions,
} from "./openapi.js";

/* Dependency injection */
export {
  token,
  Inject,
  forwardRef,
  optional,
  isForwardRef,
  isOptionalDep,
  disposeRequestScope,
  isInjectionToken,
  getConstructorDeps,
  normalizeProvider,
  createRequestScope,
  Container,
  DependencyError,
  REQUEST,
  RESPONSE,
  type InjectionToken,
  type ProviderToken,
  type Provider,
  type ValueProvider,
  type ClassProvider,
  type FactoryProvider,
  type ExistingProvider,
  type Scope,
  type Dependency,
  type ForwardRef,
  type OptionalDep,
  type RequestScope,
  type OnModuleInit,
  type OnDispose,
} from "./di.js";

/* Modules */
export {
  defineModule,
  isModuleRef,
  createApplication,
  type ModuleDefinition,
  type ModuleRef,
  type ApplicationOptions,
  type ApplicationRef,
} from "./module.js";

/* Testing */
export {
  createTestApp,
  type TestApp,
  type TestAppOptions,
} from "./testing.js";

/* Types */
export type {
  ApiDocDefinition,
  ControllerMeta,
  ExecutionContext,
  Guard,
  HttpMethod,
  Interceptor,
  ParamDefinition,
  Pipe,
  PipeMeta,
  RedirectDefinition,
  RouteDefinition,
} from "./metadata.js";
